import { config } from '../config.js';

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
}

// Type for Rigour API response failures
interface RigourAPIFailure {
  id: string;
  gate: string;
  severity: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export class RigourService {
  private apiUrl: string;

  constructor() {
    this.apiUrl = config.rigourApiUrl;
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

      // Call Rigour MCP API to analyze the changes
      const response = await fetch(`${this.apiUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `rigour-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          method: 'tools/call',
          params: {
            name: 'rigour_review',
            arguments: {
              cwd: process.cwd(), // Default to bot's working dir or handle specifically
              repository: input.repository,
              branch: input.branch,
              diff: input.diff,
              files: input.files.map((f) => f.filename),
            },
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Rigour API error: ${response.status}`);
      }

      const data = (await response.json()) as { result?: { content?: Array<{ text?: string }> } };
      const result = data.result?.content?.[0]?.text;

      if (!result) {
        // Fallback: run local analysis
        return this.analyzeLocally(input);
      }

      return this.parseRigourResponse(result, input);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Rigour API timeout, falling back to local analysis');
      } else {
        console.error('Rigour API error, falling back to local analysis:', error);
      }
      return this.analyzeLocally(input);
    }
  }

  private analyzeLocally(input: AnalyzeInput): AnalyzeResult {
    // Local analysis using pattern-based checks
    const findings: RigourFinding[] = [];

    for (const file of input.files) {
      if (!file.patch) continue;

      // Check for common drift patterns
      const fileFindings = this.checkFile(file.filename, file.patch);
      findings.push(...fileFindings);
    }

    const passed = !findings.some((f) => f.severity === 'error');

    return {
      passed,
      summary: this.generateSummary(findings),
      findings,
      annotations: this.findingsToAnnotations(findings),
      reviewBody: this.generateReviewBody(findings, input),
    };
  }

  private checkFile(filename: string, patch: string): RigourFinding[] {
    const findings: RigourFinding[] = [];
    const lines = patch.split('\n');
    let currentLine = 0;

    for (const line of lines) {
      // Track line numbers from diff header
      const lineMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (lineMatch) {
        currentLine = parseInt(lineMatch[1], 10) - 1;
        continue;
      }

      if (line.startsWith('+')) {
        currentLine++;
        const content = line.slice(1);

        // Security: Hardcoded secrets
        if (/(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]+['"]/i.test(content)) {
          findings.push({
            id: 'security-hardcoded-secret',
            gate: 'security-drift',
            severity: 'error',
            message: 'Potential hardcoded secret detected',
            file: filename,
            line: currentLine,
            suggestion: 'Use environment variables or a secrets manager',
          });
        }

        // Security: SQL injection risk
        if (/\.(execute|query)\s*\([^)]*\+|f['"].*\{.*\}.*SELECT/i.test(content)) {
          findings.push({
            id: 'security-sql-injection',
            gate: 'security-drift',
            severity: 'error',
            message: 'Potential SQL injection vulnerability',
            file: filename,
            line: currentLine,
            suggestion: 'Use parameterized queries',
          });
        }

        // Pattern: console.log in production code
        if (/console\.(log|debug|info)\(/.test(content) && !filename.includes('test')) {
          findings.push({
            id: 'pattern-console-log',
            gate: 'pattern-drift',
            severity: 'warning',
            message: 'Console statement should be removed before production',
            file: filename,
            line: currentLine,
            suggestion: 'Use a proper logging library',
          });
        }

        // Staleness: Deprecated APIs
        if (/componentWillMount|componentWillReceiveProps|componentWillUpdate/.test(content)) {
          findings.push({
            id: 'stale-react-lifecycle',
            gate: 'staleness-drift',
            severity: 'warning',
            message: 'Using deprecated React lifecycle method',
            file: filename,
            line: currentLine,
            suggestion: 'Use modern React hooks or updated lifecycle methods',
          });
        }

        // TODO/FIXME comments
        if (/\/\/\s*(TODO|FIXME|HACK|XXX):/i.test(content)) {
          findings.push({
            id: 'pattern-todo-comment',
            gate: 'pattern-drift',
            severity: 'info',
            message: 'TODO/FIXME comment detected',
            file: filename,
            line: currentLine,
          });
        }
      } else if (!line.startsWith('-')) {
        currentLine++;
      }
    }

    return findings;
  }

  private parseRigourResponse(result: string, input: AnalyzeInput): AnalyzeResult {
    // Parse the Rigour response format
    try {
      const parsed = JSON.parse(result);
      const findings: RigourFinding[] = parsed.failures?.map((f: RigourAPIFailure & { endLine?: number }) => ({
        id: f.id,
        gate: f.gate,
        severity: f.severity === 'FAIL' ? 'error' : 'warning',
        message: f.message,
        file: f.file,
        line: f.line,
        endLine: f.endLine, // Added endLine support
        suggestion: f.suggestion,
      })) || [];

      return {
        passed: parsed.status === 'PASS',
        summary: this.generateSummary(findings),
        findings,
        annotations: this.findingsToAnnotations(findings),
        reviewBody: this.generateReviewBody(findings, input),
      };
    } catch (error) {
      // FAIL SAFE: If parsing fails, fall back to local analysis instead of passing
      console.error('Failed to parse Rigour API response, falling back to local analysis:', error);
      return this.analyzeLocally(input);
    }
  }

  private generateSummary(findings: RigourFinding[]): string {
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const infos = findings.filter((f) => f.severity === 'info').length;

    if (findings.length === 0) {
      return '✅ No drift detected. All checks passed.';
    }

    const parts = [];
    if (errors > 0) parts.push(`${errors} error(s)`);
    if (warnings > 0) parts.push(`${warnings} warning(s)`);
    if (infos > 0) parts.push(`${infos} notice(s)`);

    return `Found ${parts.join(', ')}`;
  }

  private findingsToAnnotations(findings: RigourFinding[]): Array<{
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

  private generateReviewBody(findings: RigourFinding[], input: AnalyzeInput): string {
    if (findings.length === 0) {
      return `## ✅ Rigour Analysis

No issues detected in this pull request.

**Files analyzed:** ${input.files.length}
**Branch:** \`${input.branch}\` → \`${input.baseBranch}\``;
    }

    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');

    let body = `## ${errors.length > 0 ? '❌' : '⚠️'} Rigour Analysis

**Files analyzed:** ${input.files.length}
**Branch:** \`${input.branch}\` → \`${input.baseBranch}\`

`;

    if (errors.length > 0) {
      body += `### 🚨 Errors (${errors.length})\n\n`;
      for (const error of errors) {
        body += `- **${error.gate}**: ${error.message}`;
        if (error.file) body += ` (\`${error.file}:${error.line || '?'}\`)`;
        body += '\n';
        if (error.suggestion) body += `  - 💡 ${error.suggestion}\n`;
      }
      body += '\n';
    }

    if (warnings.length > 0) {
      body += `### ⚠️ Warnings (${warnings.length})\n\n`;
      for (const warning of warnings) {
        body += `- **${warning.gate}**: ${warning.message}`;
        if (warning.file) body += ` (\`${warning.file}:${warning.line || '?'}\`)`;
        body += '\n';
        if (warning.suggestion) body += `  - 💡 ${warning.suggestion}\n`;
      }
    }

    body += `\n---\n*Powered by [Rigour](https://rigour.run)*`;

    return body;
  }
}
