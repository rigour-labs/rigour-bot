import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { config, type RigourDeepMode } from '../config.js';
import { GitHubService } from './github.js';

interface AnalyzeInput {
  repository: string;
  branch: string;
  baseBranch: string;
  commit: string;
  diff: string;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  installationId: number;
}

interface RigourFinding {
  id: string;
  gate: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  endLine?: number;
  suggestion?: string;
  provenance?: string;
  category?: string;
}

interface AnalyzeResult {
  passed: boolean;
  summary: string;
  findings: RigourFinding[];
  annotations: Array<{
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: 'notice' | 'warning' | 'failure';
    message: string;
    title?: string;
  }>;
  reviewBody: string;
  engine: 'cli' | 'mcp' | 'degraded';
  fallbackReason?: string;
}

interface RigourAPIFailure {
  id: string;
  gate?: string;
  severity?: string;
  message?: string;
  details?: string;
  title?: string;
  file?: string;
  files?: string[];
  line?: number;
  endLine?: number;
  suggestion?: string;
  hint?: string;
  provenance?: string;
  category?: string;
}

interface CliReport {
  status?: string;
  failures?: RigourAPIFailure[];
  summary?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

interface RunnerResult {
  result: AnalyzeResult;
}

interface DeepExecutionPlan {
  enabled: boolean;
  mode: RigourDeepMode;
  reason?: string;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

class AsyncSemaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

class DegradedPatternRunner {
  run(input: AnalyzeInput, fallbackReason: string): RunnerResult {
    const findings: RigourFinding[] = [];

    for (const file of input.files) {
      if (!file.patch) continue;
      findings.push(...checkFilePatchPatterns(file.filename, file.patch));
    }

    const passed = !findings.some((f) => f.severity === 'error');
    const engine: AnalyzeResult['engine'] = 'degraded';
    const summary = findings.length === 0
      ? 'No drift detected (degraded mode).'
      : `Degraded analysis found ${findings.length} issue(s)`;

    return {
      result: {
        passed,
        summary,
        findings,
        annotations: findingsToAnnotations(findings),
        reviewBody: generateReviewBody(findings, input, engine, fallbackReason, undefined),
        engine,
        fallbackReason,
      },
    };
  }
}

class McpRigourRunner {
  async run(input: AnalyzeInput, tempDir: string, deep: DeepExecutionPlan): Promise<RunnerResult> {
    const resultText = await this.callTool('rigour_review', {
      cwd: tempDir,
      repository: input.repository,
      branch: input.branch,
      diff: input.diff,
      files: input.files.map((f) => f.filename),
      deep: deep.enabled,
      pro: deep.mode === 'pro',
      provider: config.rigourProvider || undefined,
      apiKey: config.rigourApiKey || undefined,
    });

    const parsed = parseMcpToolResult(resultText);
    const findings = mapFailuresToFindings(parsed.failures || []);
    const passed = parsed.status === 'PASS' || !findings.some((f) => f.severity === 'error');

    return {
      result: {
        passed,
        summary: generateSummary(findings),
        findings,
        annotations: findingsToAnnotations(findings),
        reviewBody: generateReviewBody(findings, input, 'mcp', undefined, parsed.fixPacket),
        engine: 'mcp',
      },
    };
  }

  async runSecurityAudit(tempDir: string): Promise<string | null> {
    try {
      return await this.callTool('rigour_security_audit', { cwd: tempDir });
    } catch {
      return null;
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.rigourTimeoutMs);

    try {
      const response = await fetch(`${config.rigourApiUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `rigour-${Date.now()}`,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MCP tool ${name} failed with HTTP ${response.status}`);
      }

      const data = (await response.json()) as { result?: { content?: Array<{ text?: string }> } };
      const text = data.result?.content?.[0]?.text;
      if (!text) {
        throw new Error(`MCP tool ${name} returned empty result`);
      }

      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CliRigourRunner {
  async run(input: AnalyzeInput, tempDir: string, deep: DeepExecutionPlan): Promise<RunnerResult> {
    const hasRigourConfig = await fs.pathExists(path.join(tempDir, 'rigour.yml'));
    const command = await resolveRigourCommand();
    const changedPaths = input.files
      .filter((f) => f.status !== 'removed')
      .map((f) => f.filename);

    const baseArgs = [hasRigourConfig ? 'check' : 'scan', '--json', ...changedPaths];
    const deepArgs = buildDeepArgs(deep);
    const args = [...baseArgs, ...deepArgs];

    const processResult = await runProcess(command, args, {
      cwd: tempDir,
      timeoutMs: config.rigourTimeoutMs,
      env: buildCliEnv(),
    });

    if (processResult.timedOut) {
      throw new Error(`CLI timed out after ${config.rigourTimeoutMs}ms`);
    }

    if (processResult.code !== 0 && processResult.code !== 1) {
      throw new Error(`CLI failed with code ${processResult.code}: ${safeLog(processResult.stderr || processResult.stdout)}`);
    }

    const report = parseCliReport(processResult.stdout);
    const findings = mapFailuresToFindings(report.failures || []);

    let securityNote: string | undefined;
    if (config.rigourSecurityAuditEnabled) {
      securityNote = 'Security audit requested, but CLI security audit is not directly available. Use MCP tool rigour_security_audit as secondary step.';
    }

    const fixPacket = await readFixPacketIfPresent(tempDir);
    const passed = report.status === 'PASS' || !findings.some((f) => f.severity === 'error');

    return {
      result: {
        passed,
        summary: generateSummary(findings),
        findings,
        annotations: findingsToAnnotations(findings),
        reviewBody: generateReviewBody(findings, input, 'cli', securityNote, fixPacket),
        engine: 'cli',
      },
    };
  }
}

const GLOBAL_SEMAPHORE = new AsyncSemaphore(config.rigourMaxConcurrency);

export function getExecutionChain(mode: typeof config.rigourExecMode, fallbackToMcp: boolean): Array<'cli' | 'mcp' | 'degraded'> {
  if (mode === 'mcp_only') return ['mcp', 'degraded'];
  if (mode === 'cli_only') return ['cli', 'degraded'];
  return fallbackToMcp ? ['cli', 'mcp', 'degraded'] : ['cli', 'degraded'];
}

export function mapSeverity(severity?: string): RigourFinding['severity'] {
  const value = (severity || '').toLowerCase();
  if (value === 'critical' || value === 'high' || value === 'fail' || value === 'error') return 'error';
  if (value === 'medium' || value === 'warning' || value === 'warn') return 'warning';
  return 'info';
}

export function resolveDeepExecutionPlan(input: AnalyzeInput): DeepExecutionPlan {
  if (!config.rigourDeepEnabled || config.rigourDeepMode === 'off') {
    return { enabled: false, mode: 'off', reason: 'deep_disabled' };
  }

  const [org] = input.repository.split('/');
  if (config.rigourDeepAllowedRepos.length > 0 && !config.rigourDeepAllowedRepos.includes(input.repository)) {
    return { enabled: false, mode: 'off', reason: 'repo_not_allowlisted' };
  }
  if (config.rigourDeepAllowedOrgs.length > 0 && !config.rigourDeepAllowedOrgs.includes(org)) {
    return { enabled: false, mode: 'off', reason: 'org_not_allowlisted' };
  }

  const changedLoc = input.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (changedLoc > config.rigourMaxChangedLocForDeep) {
    return {
      enabled: false,
      mode: 'off',
      reason: `changed_loc_exceeded_${config.rigourMaxChangedLocForDeep}`,
    };
  }

  return { enabled: true, mode: config.rigourDeepMode };
}

export function safeLog(text: string): string {
  let sanitized = text;
  const secrets = [
    config.privateKey,
    config.webhookSecret,
    config.rigourApiKey,
    process.env.GITHUB_PRIVATE_KEY || '',
    process.env.GITHUB_WEBHOOK_SECRET || '',
    process.env.RIGOUR_API_KEY || '',
  ].filter(Boolean);

  for (const secret of secrets) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }

  sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]');
  return sanitized;
}

export async function getRigourRuntimeReadiness(): Promise<{ cli_ready: boolean; mcp_ready: boolean }> {
  let cliReady = false;
  try {
    const command = await resolveRigourCommand();
    const result = await runProcess(command, ['--version'], {
      cwd: process.cwd(),
      timeoutMs: 2500,
      env: buildCliEnv(),
    });
    cliReady = result.code === 0;
  } catch {
    cliReady = false;
  }

  return {
    cli_ready: cliReady,
    mcp_ready: Boolean(config.rigourApiUrl),
  };
}

export class RigourService {
  private readonly cliRunner = new CliRigourRunner();
  private readonly mcpRunner = new McpRigourRunner();
  private readonly degradedRunner = new DegradedPatternRunner();

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    await GLOBAL_SEMAPHORE.acquire();

    const tempDir = path.join(os.tmpdir(), `rigour-${input.commit}-${Date.now()}`);
    const github = new GitHubService(input.installationId);
    const deepPlan = resolveDeepExecutionPlan(input);

    try {
      await fs.ensureDir(tempDir);
      await this.fetchSparseWorkspace(input, github, tempDir);

      const chain = getExecutionChain(config.rigourExecMode, config.rigourFallbackToMcp);
      let lastError = 'no_analysis_attempts';

      for (const engine of chain) {
        if (engine === 'cli') {
          try {
            return (await this.cliRunner.run(input, tempDir, deepPlan)).result;
          } catch (error) {
            lastError = `cli_error: ${safeLog(error instanceof Error ? error.message : String(error))}`;
            continue;
          }
        }

        if (engine === 'mcp') {
          try {
            const result = (await this.mcpRunner.run(input, tempDir, deepPlan)).result;
            if (lastError !== 'no_analysis_attempts') {
              result.fallbackReason = lastError;
            }
            return result;
          } catch (error) {
            lastError = `${lastError} | mcp_error: ${safeLog(error instanceof Error ? error.message : String(error))}`;
            continue;
          }
        }
      }

      return this.degradedRunner.run(input, lastError).result;
    } catch (error) {
      const reason = `analysis_pipeline_error: ${safeLog(error instanceof Error ? error.message : String(error))}`;
      console.error('Rigour analysis failed:', reason);
      return this.degradedRunner.run(input, reason).result;
    } finally {
      try {
        await fs.remove(tempDir);
      } catch (e) {
        console.error('Failed to cleanup temp workspace:', safeLog(String(e)));
      }
      GLOBAL_SEMAPHORE.release();
    }
  }

  private async fetchSparseWorkspace(input: AnalyzeInput, github: GitHubService, tempDir: string): Promise<void> {
    const [owner, repo] = input.repository.split('/');

    const fetchPromises = input.files.map(async (file) => {
      if (file.status === 'removed') return;
      try {
        const content = await github.getFileContent(owner, repo, file.filename, input.commit);
        const fullPath = path.join(tempDir, file.filename);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content);
      } catch (e) {
        console.error(`Failed to fetch ${file.filename}:`, safeLog(String(e)));
      }
    });

    // Try to include rigour config if present so CLI can run check mode.
    fetchPromises.push(
      (async () => {
        for (const configFile of ['rigour.yml', 'rigour.toml']) {
          try {
            const content = await github.getFileContent(owner, repo, configFile, input.commit);
            await fs.writeFile(path.join(tempDir, configFile), content);
            return;
          } catch {
            // best effort
          }
        }
      })()
    );

    await Promise.all(fetchPromises);
  }
}

function findingsToAnnotations(findings: RigourFinding[]): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}> {
  return findings
    .filter((f) => f.file && f.line)
    .map((f) => {
      const level: 'notice' | 'warning' | 'failure' =
        f.severity === 'error' ? 'failure' : f.severity === 'warning' ? 'warning' : 'notice';
      return {
        path: f.file!,
        start_line: f.line!,
        end_line: f.endLine || f.line!,
        annotation_level: level,
        message: f.suggestion ? `${f.message}\n\nSuggestion: ${f.suggestion}` : f.message,
        title: f.gate,
      };
    });
}

function generateSummary(findings: RigourFinding[]): string {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;

  if (findings.length === 0) {
    return 'No drift detected. All checks passed.';
  }

  const parts = [];
  if (errors > 0) parts.push(`${errors} error(s)`);
  if (warnings > 0) parts.push(`${warnings} warning(s)`);
  if (infos > 0) parts.push(`${infos} notice(s)`);
  return `Found ${parts.join(', ')}`;
}

function generateReviewBody(
  findings: RigourFinding[],
  input: AnalyzeInput,
  engine: AnalyzeResult['engine'],
  note?: string,
  fixPacket?: string
): string {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');

  let body = `## ${errors.length > 0 ? 'FAIL' : 'PASS'} Rigour Analysis\n\n`;
  body += `- Engine: \`${engine}\`\n`;
  body += `- Files analyzed: ${input.files.length}\n`;
  body += `- Branch: \`${input.branch}\` -> \`${input.baseBranch}\`\n\n`;

  if (note) {
    body += `> Note: ${note}\n\n`;
  }

  if (findings.length === 0) {
    body += 'No issues detected in this pull request.\n';
    return body;
  }

  if (errors.length > 0) {
    body += `### Errors (${errors.length})\n`;
    for (const error of errors) {
      body += `- **${error.gate}**: ${error.message}`;
      if (error.file) body += ` (\`${error.file}:${error.line || '?'}\`)`;
      body += '\n';
      if (error.suggestion) body += `  - Suggestion: ${error.suggestion}\n`;
    }
    body += '\n';
  }

  if (warnings.length > 0) {
    body += `### Warnings (${warnings.length})\n`;
    for (const warning of warnings) {
      body += `- **${warning.gate}**: ${warning.message}`;
      if (warning.file) body += ` (\`${warning.file}:${warning.line || '?'}\`)`;
      body += '\n';
      if (warning.suggestion) body += `  - Suggestion: ${warning.suggestion}\n`;
    }
    body += '\n';
  }

  if (infos.length > 0) {
    body += `### Notices (${infos.length})\n`;
    for (const info of infos) {
      body += `- **${info.gate}**: ${info.message}`;
      if (info.file) body += ` (\`${info.file}:${info.line || '?'}\`)`;
      body += '\n';
    }
    body += '\n';
  }

  if (fixPacket) {
    body += '### Fix Packet\n';
    body += '```\n';
    body += `${fixPacket.slice(0, 3500)}${fixPacket.length > 3500 ? '\n...truncated...' : ''}\n`;
    body += '```\n\n';
  }

  body += '---\n';
  body += '*Powered by Rigour*';

  return body;
}

function mapFailuresToFindings(failures: RigourAPIFailure[]): RigourFinding[] {
  return failures.map((failure) => {
    const location = extractLocation(failure);
    return {
      id: failure.id || 'unknown',
      gate: failure.gate || failure.category || 'quality-gate',
      severity: mapSeverity(failure.severity),
      message: failure.message || failure.title || failure.details || 'Quality issue detected',
      file: location.file,
      line: location.line,
      endLine: failure.endLine || location.line,
      suggestion: failure.suggestion || failure.hint,
      provenance: failure.provenance,
      category: failure.category,
    };
  });
}

function extractLocation(failure: RigourAPIFailure): { file?: string; line?: number } {
  if (failure.file) {
    return { file: failure.file, line: failure.line };
  }

  const source = failure.files?.[0];
  if (!source) return {};

  const match = source.match(/^(.+?)(?::(\d+))?$/);
  if (!match) return { file: source };

  return {
    file: match[1],
    line: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

function parseMcpToolResult(text: string): { status: string; failures: RigourAPIFailure[]; fixPacket?: string } {
  const maybeJson = tryParseJson(text);
  if (maybeJson && typeof maybeJson === 'object') {
    const report = maybeJson as { status?: string; failures?: RigourAPIFailure[]; packet?: string };
    return {
      status: report.status || 'UNKNOWN',
      failures: report.failures || [],
      fixPacket: report.packet,
    };
  }

  // If text is not machine JSON, fail softly with no findings.
  return {
    status: /PASS/i.test(text) ? 'PASS' : 'UNKNOWN',
    failures: [],
    fixPacket: text.includes('FIX TASK') ? text : undefined,
  };
}

function parseCliReport(stdout: string): CliReport {
  const direct = tryParseJson(stdout);
  if (direct && typeof direct === 'object') {
    return direct as CliReport;
  }

  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = stdout.slice(start, end + 1);
    const parsed = tryParseJson(sliced);
    if (parsed && typeof parsed === 'object') {
      return parsed as CliReport;
    }
  }

  throw new Error(`CLI returned non-JSON output: ${safeLog(stdout.slice(0, 300))}`);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildDeepArgs(deep: DeepExecutionPlan): string[] {
  if (!deep.enabled || deep.mode === 'off') return [];

  const args = ['--deep'];
  if (deep.mode === 'pro') args.push('--pro');
  if (config.rigourProvider) args.push('--provider', config.rigourProvider);
  if (config.rigourApiKey) args.push('--api-key', config.rigourApiKey);
  if (config.rigourApiBaseUrl) args.push('--api-base-url', config.rigourApiBaseUrl);
  if (config.rigourModelName) args.push('--model-name', config.rigourModelName);
  return args;
}

function buildCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Ensure logs remain quiet by default in bot execution.
    RIGOUR_DEBUG: process.env.RIGOUR_DEBUG || '0',
  };
}

async function resolveRigourCommand(): Promise<string> {
  const explicit = process.env.RIGOUR_CLI_PATH;
  if (explicit) return explicit;

  const localBin = path.resolve(process.cwd(), 'node_modules/.bin/rigour');
  if (await fs.pathExists(localBin)) return localBin;

  return 'rigour';
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function readFixPacketIfPresent(tempDir: string): Promise<string | undefined> {
  const fixPacketPath = path.join(tempDir, 'rigour-fix-packet.json');
  if (!(await fs.pathExists(fixPacketPath))) {
    return undefined;
  }

  try {
    return await fs.readFile(fixPacketPath, 'utf-8');
  } catch {
    return undefined;
  }
}

function checkFilePatchPatterns(filename: string, patch: string): RigourFinding[] {
  const findings: RigourFinding[] = [];
  const lines = patch.split('\n');
  let currentLine = 0;

  for (const line of lines) {
    const lineMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (lineMatch) {
      currentLine = parseInt(lineMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith('+')) {
      currentLine += 1;
      const content = line.slice(1);

      if (/(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]+['"]/i.test(content)) {
        findings.push({
          id: 'security-hardcoded-secret',
          gate: 'security-drift',
          severity: 'error',
          message: 'Potential hardcoded secret detected',
          file: filename,
          line: currentLine,
          suggestion: 'Use environment variables or a secrets manager',
          provenance: 'degraded-fallback',
        });
      }

      if (/\.(execute|query)\s*\([^)]*\+|f['"].*\{.*\}.*SELECT/i.test(content)) {
        findings.push({
          id: 'security-sql-injection',
          gate: 'security-drift',
          severity: 'error',
          message: 'Potential SQL injection vulnerability',
          file: filename,
          line: currentLine,
          suggestion: 'Use parameterized queries',
          provenance: 'degraded-fallback',
        });
      }

      if (/console\.(log|debug|info)\(/.test(content) && !filename.includes('test')) {
        findings.push({
          id: 'pattern-console-log',
          gate: 'pattern-drift',
          severity: 'warning',
          message: 'Console statement should be removed before production',
          file: filename,
          line: currentLine,
          suggestion: 'Use a proper logging library',
          provenance: 'degraded-fallback',
        });
      }

      if (/componentWillMount|componentWillReceiveProps|componentWillUpdate/.test(content)) {
        findings.push({
          id: 'stale-react-lifecycle',
          gate: 'staleness-drift',
          severity: 'warning',
          message: 'Using deprecated React lifecycle method',
          file: filename,
          line: currentLine,
          suggestion: 'Use modern React hooks or updated lifecycle methods',
          provenance: 'degraded-fallback',
        });
      }

      if (/\/\/\s*(TODO|FIXME|HACK|XXX):/i.test(content)) {
        findings.push({
          id: 'pattern-todo-comment',
          gate: 'pattern-drift',
          severity: 'info',
          message: 'TODO/FIXME comment detected',
          file: filename,
          line: currentLine,
          provenance: 'degraded-fallback',
        });
      }
    } else if (!line.startsWith('-')) {
      currentLine += 1;
    }
  }

  return findings;
}
