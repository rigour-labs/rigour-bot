import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { config } from '../config.js';

interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}

export class GitHubService {
  private octokit: Octokit;

  constructor(installationId: number) {
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId,
      },
    });
  }

  async createCheckRun(
    owner: string,
    repo: string,
    headSha: string,
    name: string,
    status: 'queued' | 'in_progress' | 'completed',
    conclusion?: string
  ): Promise<number> {
    const response = await this.octokit.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status,
      ...(status === 'completed' && conclusion ? { conclusion } : {}),
      started_at: new Date().toISOString(),
    });

    return response.data.id;
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required',
    summary: string,
    annotations: Annotation[] = []
  ): Promise<void> {
    // GitHub API limits annotations to 50 per request
    const annotationChunks = this.chunkArray(annotations, 50);

    // First update with conclusion and first batch of annotations
    await this.octokit.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: conclusion === 'success' ? 'Rigour: All checks passed' : 'Rigour: Issues detected',
        summary,
        annotations: annotationChunks[0] || [],
      },
    });

    // Add remaining annotations in subsequent requests
    for (let i = 1; i < annotationChunks.length; i++) {
      await this.octokit.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        output: {
          title: conclusion === 'success' ? 'Rigour: All checks passed' : 'Rigour: Issues detected',
          summary,
          annotations: annotationChunks[i],
        },
      });
    }
  }

  async getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });

    return response.data as unknown as string;
  }

  async getPRFiles(owner: string, repo: string, prNumber: number): Promise<PRFile[]> {
    const response = await this.octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    return response.data.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }));
  }

  async createReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  ): Promise<void> {
    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      body,
      event,
    });
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const response = await this.octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ('content' in response.data) {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }

    throw new Error(`Unable to get content for ${path}`);
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
