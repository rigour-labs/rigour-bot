import { PullRequestEvent } from '@octokit/webhooks-types';
import { RigourService } from '../services/rigour.js';
import { GitHubService } from '../services/github.js';

// Track in-progress analyses to prevent duplicates
const inProgressAnalyses = new Map<string, boolean>();

function getAnalysisKey(repo: string, prNumber: number, sha: string): string {
  return `${repo}#${prNumber}@${sha}`;
}

export async function handlePullRequest(payload: PullRequestEvent): Promise<void> {
  const { pull_request: pr, repository, installation } = payload;

  if (!installation?.id) {
    console.error('No installation ID found in payload');
    return;
  }

  // Deduplicate rapid webhook events
  const analysisKey = getAnalysisKey(repository.full_name, pr.number, pr.head.sha);
  if (inProgressAnalyses.get(analysisKey)) {
    console.log(`⏭️  Skipping duplicate analysis for ${analysisKey}`);
    return;
  }
  inProgressAnalyses.set(analysisKey, true);

  const github = new GitHubService(installation.id);
  const rigour = new RigourService();
  let checkRunId: number | null = null;

  try {
    // Create a check run to show we're analyzing
    checkRunId = await github.createCheckRun(
      repository.owner.login,
      repository.name,
      pr.head.sha,
      'Rigour Analysis',
      'in_progress'
    );

    // Get the PR diff
    const diff = await github.getPRDiff(
      repository.owner.login,
      repository.name,
      pr.number
    );

    // Get changed files (with pagination)
    const files = await github.getPRFiles(
      repository.owner.login,
      repository.name,
      pr.number
    );

    // Run Rigour analysis on the changes
    const result = await rigour.analyze({
      repository: repository.full_name,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      commit: pr.head.sha,
      diff,
      files: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
      installationId: installation.id,
    });

    // Update check run with results
    await github.updateCheckRun(
      repository.owner.login,
      repository.name,
      checkRunId,
      result.passed ? 'success' : 'failure',
      result.summary,
      result.annotations
    );

    // Post review comment if there are findings
    if (result.findings.length > 0) {
      await github.createReviewComment(
        repository.owner.login,
        repository.name,
        pr.number,
        result.reviewBody,
        result.passed ? 'COMMENT' : 'REQUEST_CHANGES'
      );
    }

    console.log(
      `✅ Analysis complete for ${repository.full_name}#${pr.number}: ${result.passed ? 'PASSED' : 'FAILED'}`
    );
  } catch (error) {
    console.error(`Error analyzing PR ${repository.full_name}#${pr.number}:`, error);

    // Update the EXISTING check run with error (not create new one)
    if (checkRunId) {
      try {
        await github.updateCheckRun(
          repository.owner.login,
          repository.name,
          checkRunId,
          'failure',
          `An error occurred during analysis: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } catch (updateError) {
        console.error('Failed to update check run with error:', updateError);
      }
    }
  } finally {
    // Clean up deduplication tracking
    inProgressAnalyses.delete(analysisKey);
  }
}
