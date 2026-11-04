/**
 * Tiny message template engine.
 *
 *   {{name}}                    → value of "name"
 *   {{doc.customer}}            → nested lookup
 *   {{#due_date}}Due {{due_date}}{{/due_date}}   → only rendered when due_date is set
 *   {{^due_date}}No due date{{/due_date}}        → only rendered when due_date is empty
 *
 * A line that contained a tag and ends up empty is removed, so optional lines
 * disappear cleanly instead of leaving blank gaps.
 */

const MARK = '\u0000';

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.trim() !== '';
  return Boolean(value);
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).split(MARK).join('');
}

const SECTION = /\{\{\s*([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/g;
const VARIABLE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  // Mark every line that contains a tag so we can drop it later if it renders empty.
  const marked = template
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('{{') ? `${line}${MARK}` : line))
    .join('\n');

  let output = marked;
  // Resolve sections repeatedly so nested sections work.
  for (let i = 0; i < 5; i++) {
    const next = output.replace(SECTION, (_m, kind: string, key: string, inner: string) => {
      const truthy = isTruthy(lookup(vars, key));
      return (kind === '#' ? truthy : !truthy) ? inner : '';
    });
    if (next === output) break;
    output = next;
  }
  output = output.replace(VARIABLE, (_m, key: string) => toText(lookup(vars, key)));

  return output
    .split('\n')
    .filter((line) => !(line.includes(MARK) && line.split(MARK).join('').trim() === ''))
    .map((line) => line.split(MARK).join(''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lists the variable names used in a template (for validation hints in the dashboard). */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*[#^/]?\s*([\w.]+)\s*\}\}/g)) names.add(match[1]);
  return [...names];
}
