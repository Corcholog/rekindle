import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import YAML from 'yaml';

// The license, its NOTICE and the citation file must agree, since forks are asked to keep them.
describe('license and citation', () => {
  it('is Apache-2.0 everywhere, with the author credited in NOTICE and CITATION.cff', () => {
    expect(fs.readFileSync('LICENSE', 'utf-8')).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const citation = YAML.parse(fs.readFileSync('CITATION.cff', 'utf-8'));
    expect(pkg.license).toBe('Apache-2.0');
    expect(citation.license).toBe(pkg.license);
    expect(citation['cff-version']).toBe('1.2.0');
    expect(citation.authors[0]).toMatchObject({ 'given-names': 'Giorgio Ivan', 'family-names': 'Loguercio' });
    expect(fs.readFileSync('NOTICE', 'utf-8')).toContain('Giorgio Ivan Loguercio');
  });
});
