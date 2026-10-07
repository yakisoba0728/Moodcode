import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TextPosition, TextRange } from '../../formatters/edits.js';

export interface ExpectedSemanticLocation { path: string; range: TextRange }
export interface SemanticProbe {
  id: string;
  kind: 'definition' | 'references';
  path: string;
  position: TextPosition;
  expected: ExpectedSemanticLocation[];
}
export interface AuthoredSemanticCorpus {
  modules: number;
  files: Map<string, string>;
  bytes: number;
  probes: SemanticProbe[];
  boundedReferences: SemanticProbe;
  outside: SemanticProbe;
  ignored: SemanticProbe;
}
/** Labels are computed solely from authored source text, independently of all LSP responses. */
export function authoredRange(text: string, identifier: string, occurrence = 0): TextRange {
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(identifier, offset + 1);
    if (offset < 0) throw new Error(`Missing authored label ${identifier}#${occurrence}`);
  }
  const prefix = text.slice(0, offset), lines = prefix.split(/\r\n|\r|\n/);
  const start = { line: lines.length - 1, character: lines.at(-1)!.length };
  return { start, end: { line: start.line, character: start.character + identifier.length } };
}
export function semanticLocationKey(location: ExpectedSemanticLocation): string {
  return `${location.path}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
}
export function semanticScore(actual: readonly ExpectedSemanticLocation[], expected: readonly ExpectedSemanticLocation[]) {
  const received = new Set(actual.map(semanticLocationKey)), labels = new Set(expected.map(semanticLocationKey));
  const truePositive = [...received].filter(value => labels.has(value)).length;
  return { expected: labels.size, returned: received.size, truePositive, falsePositive: received.size - truePositive,
    falseNegative: labels.size - truePositive, precision: received.size ? truePositive / received.size : labels.size ? 0 : 1,
    recall: labels.size ? truePositive / labels.size : received.size ? 0 : 1 };
}
/** A small checked-in generator produces 512+ real modules without checking generated source into Git. */
export async function writeSemanticCorpus(root: string, modules = 512): Promise<AuthoredSemanticCorpus> {
  if (!Number.isSafeInteger(modules) || modules < 512 || modules > 1024) throw new Error('Corpus modules must be within 512..1024');
  await mkdir(join(root, 'modules'), { recursive: true });
  const files = new Map<string, string>();
  files.set('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'es2025', module: 'nodenext', strict: true, skipLibCheck: true, noEmit: true }, include: ['**/*.ts'] }));
  files.set('.gitignore', 'ignored.ts\n');
  for (let index = 0; index < modules; index++) {
    const name = `modules/m${String(index).padStart(3, '0')}.ts`;
    files.set(name, `export function duplicate(value: number): number { return value + ${index}; }\nexport const marker${index} = duplicate(${index});\n`);
  }
  files.set('aliases.ts', 'import { duplicate as first } from "./modules/m000.js";\nimport { duplicate as last } from "./modules/m511.js";\nexport const selected = first(1) + last(2);\n');
  files.set('barrel.ts', 'export { duplicate as forwarded } from "./modules/m003.js";\n');
  files.set('reexport-use.ts', 'import { forwarded } from "./barrel.js";\nexport const throughBarrel = forwarded(3);\n');
  files.set('shadow.ts', 'import { duplicate as shared } from "./modules/m002.js";\nexport function sample(duplicate: number) {\n  const label = "😀"; return duplicate + shared(2) + label.length;\n}\n');
  files.set('unicode.ts', '\uFEFFconst astral = "😀"; export function όνομα(value: number) { return value + astral.length; }\r\nexport const unicodeResult = όνομα(4);\r\n');
  files.set('references.ts', 'export const target = 1;\n' + Array.from({ length: 80 }, (_, index) => `export const reference${index} = target + ${index};\n`).join(''));
  files.set('outside-use.ts', 'import { external } from "../outside.js";\nexport const outsideResult = external();\n');
  files.set('ignored.ts', 'export function ignored() { return 7; }\n');
  files.set('ignored-use.ts', 'import { ignored } from "./ignored.js";\nexport const ignoredResult = ignored();\n');
  files.set('partial.ts', 'import { unresolved } from "./not-authored.js";\nexport const survives = 1;\nexport const missingDependency = unresolved;\n');
  files.set('unsupported.txt', 'Authored non TypeScript input; host routing stays unsupported.\n');
  await Promise.all([...files].map(([path, text]) => writeFile(join(root, path), text)));
  await writeFile(join(root, '../outside.ts'), 'export function external() { return 9; }\n');
  const location = (path: string, name: string, occurrence = 0): ExpectedSemanticLocation => ({ path, range: authoredRange(files.get(path)!, name, occurrence) });
  const probe = (id: string, path: string, name: string, occurrence: number, expected: ExpectedSemanticLocation[], kind: SemanticProbe['kind'] = 'definition'): SemanticProbe => ({
    id, kind, path, position: authoredRange(files.get(path)!, name, occurrence).start, expected });
  const probes = [
    probe('duplicate-import-first', 'aliases.ts', 'first', 1, [location('modules/m000.ts', 'duplicate')]),
    probe('duplicate-import-last', 'aliases.ts', 'last', 1, [location('modules/m511.ts', 'duplicate')]),
    probe('barrel-reexport-alias', 'reexport-use.ts', 'forwarded', 1, [location('modules/m003.ts', 'duplicate')]),
    probe('local-shadow', 'shadow.ts', 'duplicate', 2, [location('shadow.ts', 'duplicate', 1)]),
    probe('shadow-import-alias', 'shadow.ts', 'shared', 1, [location('modules/m002.ts', 'duplicate')]),
    probe('bom-crlf-astral-definition', 'unicode.ts', 'όνομα', 1, [location('unicode.ts', 'όνομα')]),
    probe('isolated-homonym-references', 'modules/m010.ts', 'duplicate', 1, [location('modules/m010.ts', 'duplicate'), location('modules/m010.ts', 'duplicate', 1)], 'references'),
    probe('bom-crlf-astral-references', 'unicode.ts', 'όνομα', 1, [location('unicode.ts', 'όνομα'), location('unicode.ts', 'όνομα', 1)], 'references'),
  ];
  return { modules, files, bytes: [...files.values()].reduce((total, text) => total + Buffer.byteLength(text), 0), probes,
    boundedReferences: probe('bounded-references', 'references.ts', 'target', 0, Array.from({ length: 81 }, (_, index) => location('references.ts', 'target', index)), 'references'),
    outside: probe('outside-root', 'outside-use.ts', 'external', 1, []), ignored: probe('ignored-target', 'ignored-use.ts', 'ignored', 1, []) };
}
