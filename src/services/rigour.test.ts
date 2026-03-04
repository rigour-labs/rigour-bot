import { describe, expect, it } from 'vitest';
import { getExecutionChain, mapSeverity, safeLog } from './rigour.js';

describe('Rigour execution chain', () => {
  it('uses CLI then MCP then degraded in cli_first mode when fallback is enabled', () => {
    expect(getExecutionChain('cli_first', true)).toEqual(['cli', 'mcp', 'degraded']);
  });

  it('uses CLI then degraded in cli_only mode', () => {
    expect(getExecutionChain('cli_only', true)).toEqual(['cli', 'degraded']);
  });

  it('uses MCP then degraded in mcp_only mode', () => {
    expect(getExecutionChain('mcp_only', true)).toEqual(['mcp', 'degraded']);
  });
});

describe('Rigour severity mapping', () => {
  it('maps critical/high to error', () => {
    expect(mapSeverity('critical')).toBe('error');
    expect(mapSeverity('HIGH')).toBe('error');
  });

  it('maps medium/warning to warning', () => {
    expect(mapSeverity('medium')).toBe('warning');
    expect(mapSeverity('warning')).toBe('warning');
  });

  it('maps unknown to info', () => {
    expect(mapSeverity('low')).toBe('info');
  });
});

describe('Rigour safe logging', () => {
  it('redacts bearer tokens', () => {
    const output = safeLog('Authorization: Bearer abc123tokenvalue');
    expect(output).toContain('Bearer [REDACTED]');
    expect(output).not.toContain('abc123tokenvalue');
  });
});
