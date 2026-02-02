import { Application } from 'express';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';
import { config } from '../config.js';
import { handlePullRequest } from './pull-request.js';

export function setupWebhooks(app: Application): void {
  // SECURITY: Require webhook secret in production
  if (!config.webhookSecret) {
    if (config.nodeEnv === 'production') {
      throw new Error('GITHUB_WEBHOOK_SECRET is required in production');
    }
    console.warn('⚠️  GITHUB_WEBHOOK_SECRET not set - webhook signature verification disabled (dev only)');
  }

  const webhooks = new Webhooks({
    secret: config.webhookSecret || 'development-only-secret',
  });

  // Handle pull request events
  webhooks.on('pull_request.opened', async ({ payload }) => {
    console.log(`📥 PR opened: ${payload.repository.full_name}#${payload.pull_request.number}`);
    await handlePullRequest(payload);
  });

  webhooks.on('pull_request.synchronize', async ({ payload }) => {
    console.log(`🔄 PR updated: ${payload.repository.full_name}#${payload.pull_request.number}`);
    await handlePullRequest(payload);
  });

  webhooks.on('pull_request.reopened', async ({ payload }) => {
    console.log(`🔓 PR reopened: ${payload.repository.full_name}#${payload.pull_request.number}`);
    await handlePullRequest(payload);
  });

  // Handle check run requests (re-run)
  webhooks.on('check_run.rerequested', async ({ payload }) => {
    console.log(`🔁 Check re-requested: ${payload.repository.full_name}`);
    // TODO: Re-run Rigour analysis
  });

  // Handle installation events
  webhooks.on('installation.created', async ({ payload }) => {
    console.log(`✅ App installed on: ${payload.installation.account?.login}`);
  });

  webhooks.on('installation.deleted', async ({ payload }) => {
    console.log(`❌ App uninstalled from: ${payload.installation.account?.login}`);
  });

  // Error handling
  webhooks.onError((error) => {
    console.error('Webhook error:', error);
  });

  // Mount webhook middleware
  app.use('/webhooks', createNodeMiddleware(webhooks));
}
