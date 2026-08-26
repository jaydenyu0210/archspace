import { parsePortType, type ParsedType } from '@archspace/types';

/** Base color family for a port type — lists take their item's color. */
export function portColorVar(type: string): string {
  const parsed = parsePortType(type);
  return parsed ? colorFor(parsed) : 'var(--port-any)';
}

function colorFor(t: ParsedType): string {
  switch (t.kind) {
    case 'any': return 'var(--port-any)';
    case 'list': return colorFor(t.item);
    case 'asset': return 'var(--port-asset)';
    case 'plugin': return 'var(--port-plugin)';
    case 'primitive':
      switch (t.name) {
        case 'text': return 'var(--port-text)';
        case 'number': return 'var(--port-number)';
        case 'boolean': return 'var(--port-boolean)';
        case 'json': return 'var(--port-json)';
        case 'chat': return 'var(--port-chat)';
        case 'table': return 'var(--port-table)';
      }
  }
}
