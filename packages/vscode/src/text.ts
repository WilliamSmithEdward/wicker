/**
 * A count with its noun, pluralised the way the labels in this extension
 * pluralise: "1 template", "2 templates". Three places had written it out.
 */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
