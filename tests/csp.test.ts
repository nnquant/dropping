// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

describe('content security policy', () => {
  it('loads table and Parquet support without compiling WebAssembly, which the app CSP blocks', async () => {
    const compile = vi.spyOn(WebAssembly, 'Module');
    const instantiate = vi.spyOn(WebAssembly, 'Instance');
    await import('../src/tables');
    expect(compile).not.toHaveBeenCalled();
    expect(instantiate).not.toHaveBeenCalled();
  });
});
