type ScratchpadEntry = {
  name: string;
  value: unknown;
  source: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
};

type TransformOperation =
  | 'pluck'
  | 'sortBy'
  | 'filterEquals'
  | 'filterGreaterThan'
  | 'filterIncludes'
  | 'count'
  | 'sum'
  | 'average';

const scratchpad = new Map<string, Map<string, ScratchpadEntry>>();

function getConversationStore(conversationId: string): Map<string, ScratchpadEntry> {
  let store = scratchpad.get(conversationId);
  if (!store) {
    store = new Map<string, ScratchpadEntry>();
    scratchpad.set(conversationId, store);
  }
  return store;
}

function summarizeValue(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (typeof value === 'object') {
    return `Object(${Object.keys(value as Record<string, unknown>).length} keys)`;
  }
  return typeof value;
}

function getValueAtPath(input: unknown, path: string | undefined): unknown {
  if (!path) return input;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isNaN(index) ? undefined : current[index];
    }
    if (typeof current === 'object') {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, input);
}

function normalizeArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error('Scratchpad variable is not an array');
  }
  return value.map((item) => (typeof item === 'object' && item !== null ? item as Record<string, unknown> : { value: item }));
}

function ensureNumeric(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) {
    throw new Error(`Expected numeric value, received ${String(value)}`);
  }
  return numeric;
}

export function listScratchpadEntries(conversationId: string): ScratchpadEntry[] {
  return Array.from(getConversationStore(conversationId).values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getScratchpadEntry(conversationId: string, name: string): ScratchpadEntry | null {
  return getConversationStore(conversationId).get(name) ?? null;
}

export function setScratchpadEntry(conversationId: string, name: string, value: unknown, source: string): ScratchpadEntry {
  const store = getConversationStore(conversationId);
  const now = new Date().toISOString();
  const existing = store.get(name);
  const entry: ScratchpadEntry = {
    name,
    value,
    source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    summary: summarizeValue(value),
  };
  store.set(name, entry);
  return entry;
}

export function autoStoreToolResult(conversationId: string, toolName: string, result: unknown): ScratchpadEntry[] {
  const timestamp = Date.now();
  const autoName = `${toolName}_${timestamp}`;
  const entries = [
    setScratchpadEntry(conversationId, 'last_result', result, `tool:${toolName}`),
    setScratchpadEntry(conversationId, `last_${toolName}`, result, `tool:${toolName}`),
    setScratchpadEntry(conversationId, autoName, result, `tool:${toolName}`),
  ];
  return entries;
}

export function aliasScratchpadEntry(
  conversationId: string,
  sourceName: string,
  aliasName: string,
  source = 'scratchpad.alias',
): ScratchpadEntry {
  const existing = getScratchpadEntry(conversationId, sourceName);
  if (!existing) {
    throw new Error(`Scratchpad variable not found: ${sourceName}`);
  }
  return setScratchpadEntry(conversationId, aliasName, existing.value, source);
}

export function clearScratchpad(conversationId: string): void {
  scratchpad.delete(conversationId);
}

export function deleteScratchpadEntry(conversationId: string, name: string): boolean {
  return getConversationStore(conversationId).delete(name);
}

export function transformScratchpadData(args: {
  conversationId: string;
  sourceName: string;
  operation: TransformOperation;
  outputName?: string;
  field?: string;
  value?: unknown;
  order?: 'asc' | 'desc';
}): ScratchpadEntry {
  const source = getScratchpadEntry(args.conversationId, args.sourceName);
  if (!source) {
    throw new Error(`Scratchpad variable not found: ${args.sourceName}`);
  }

  let result: unknown;
  const items = ['pluck', 'sortBy', 'filterEquals', 'filterGreaterThan', 'filterIncludes'].includes(args.operation)
    ? normalizeArray(source.value)
    : null;

  switch (args.operation) {
    case 'pluck': {
      if (!args.field) throw new Error('field is required for pluck');
      result = items!.map((item) => getValueAtPath(item, args.field));
      break;
    }
    case 'sortBy': {
      if (!args.field) throw new Error('field is required for sortBy');
      result = [...items!].sort((left, right) => {
        const leftValue = getValueAtPath(left, args.field);
        const rightValue = getValueAtPath(right, args.field);
        if (leftValue === rightValue) return 0;
        if (leftValue == null) return 1;
        if (rightValue == null) return -1;
        return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
      });
      if ((args.order ?? 'asc') === 'desc') {
        (result as Array<Record<string, unknown>>).reverse();
      }
      break;
    }
    case 'filterEquals': {
      if (!args.field) throw new Error('field is required for filterEquals');
      result = items!.filter((item) => getValueAtPath(item, args.field) === args.value);
      break;
    }
    case 'filterGreaterThan': {
      if (!args.field) throw new Error('field is required for filterGreaterThan');
      const threshold = ensureNumeric(args.value);
      result = items!.filter((item) => ensureNumeric(getValueAtPath(item, args.field)) > threshold);
      break;
    }
    case 'filterIncludes': {
      if (!args.field) throw new Error('field is required for filterIncludes');
      const needle = String(args.value ?? '').toLowerCase();
      result = items!.filter((item) => String(getValueAtPath(item, args.field) ?? '').toLowerCase().includes(needle));
      break;
    }
    case 'count': {
      result = Array.isArray(source.value) ? source.value.length : Object.keys((source.value as Record<string, unknown>) ?? {}).length;
      break;
    }
    case 'sum': {
      if (!args.field) throw new Error('field is required for sum');
      result = normalizeArray(source.value).reduce((total, item) => total + ensureNumeric(getValueAtPath(item, args.field)), 0);
      break;
    }
    case 'average': {
      if (!args.field) throw new Error('field is required for average');
      const array = normalizeArray(source.value);
      const sum = array.reduce((total, item) => total + ensureNumeric(getValueAtPath(item, args.field)), 0);
      result = array.length > 0 ? sum / array.length : 0;
      break;
    }
    default:
      throw new Error(`Unsupported scratchpad operation: ${String(args.operation)}`);
  }

  return setScratchpadEntry(
    args.conversationId,
    args.outputName ?? `${args.sourceName}_${args.operation}`,
    result,
    `scratchpad.transform:${args.operation}`,
  );
}

function collectDiffs(left: unknown, right: unknown, path: string, output: string[]): void {
  if (output.length >= 50) return;

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      output.push(`${path || 'root'} length changed: ${left.length} → ${right.length}`);
    }
    const max = Math.min(Math.max(left.length, right.length), 10);
    for (let index = 0; index < max; index += 1) {
      collectDiffs(left[index], right[index], `${path}[${index}]`, output);
      if (output.length >= 50) return;
    }
    return;
  }

  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const keys = new Set([...Object.keys(left as Record<string, unknown>), ...Object.keys(right as Record<string, unknown>)]);
    for (const key of keys) {
      collectDiffs(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        output,
      );
      if (output.length >= 50) return;
    }
    return;
  }

  if (JSON.stringify(left) !== JSON.stringify(right)) {
    output.push(`${path || 'root'} changed: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
  }
}

export function compareScratchpadSnapshots(conversationId: string, leftName: string, rightName: string): ScratchpadEntry {
  const left = getScratchpadEntry(conversationId, leftName);
  const right = getScratchpadEntry(conversationId, rightName);
  if (!left || !right) {
    throw new Error(`Missing scratchpad variable(s): ${!left ? leftName : ''} ${!right ? rightName : ''}`.trim());
  }

  const changes: string[] = [];
  collectDiffs(left.value, right.value, '', changes);
  const result = {
    left: leftName,
    right: rightName,
    changeCount: changes.length,
    changes,
  };

  return setScratchpadEntry(conversationId, `diff_${leftName}_${rightName}`, result, 'scratchpad.compare');
}
