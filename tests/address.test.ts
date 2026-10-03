import { describe, expect, it } from 'vitest';
import { breadcrumbs } from '../src/AddressBar';

describe('breadcrumbs', () => {
  it('splits Windows drive paths with either separator', () => {
    expect(breadcrumbs('C:\\Users\\jiang\\projects')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'jiang', path: 'C:\\Users\\jiang' },
      { label: 'projects', path: 'C:\\Users\\jiang\\projects' },
    ]);
    expect(breadcrumbs('C:\\')).toEqual([{ label: 'C:', path: 'C:\\' }]);
    expect(breadcrumbs('D:/data/run/')).toEqual([
      { label: 'D:', path: 'D:/' },
      { label: 'data', path: 'D:/data' },
      { label: 'run', path: 'D:/data/run' },
    ]);
  });

  it('keeps UNC shares and POSIX roots as the first crumb', () => {
    expect(breadcrumbs('\\\\nas\\share\\models')).toEqual([
      { label: '\\\\nas\\share', path: '\\\\nas\\share' },
      { label: 'models', path: '\\\\nas\\share\\models' },
    ]);
    expect(breadcrumbs('/home/research/outputs')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'research', path: '/home/research' },
      { label: 'outputs', path: '/home/research/outputs' },
    ]);
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
    expect(breadcrumbs('')).toEqual([]);
  });
});
