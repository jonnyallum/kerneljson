/** JSON.parse alone accepts duplicate keys. Authority artefacts must not. */
export function strictJson(text: string): unknown {
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? "x")) i++; };
  const fail = (): never => { throw new Error(`INVALID_JSON at byte offset ${i}`); };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    return fail();
  }
  function value(): unknown {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++; ws();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[i] === "}") { i++; return result; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') return fail();
        const key = string();
        if (Object.hasOwn(result, key)) throw new Error(`DUPLICATE_JSON_KEY: ${key}`);
        ws(); if (text[i++] !== ":") return fail();
        result[key] = value(); ws();
        if (text[i] === "}") { i++; return result; }
        if (text[i++] !== ",") return fail();
      }
      return fail();
    }
    if (text[i] === "[") {
      i++; ws(); const result: unknown[] = [];
      if (text[i] === "]") { i++; return result; }
      while (i < text.length) {
        result.push(value()); ws();
        if (text[i] === "]") { i++; return result; }
        if (text[i++] !== ",") return fail();
      }
      return fail();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!token) return fail();
    i += token[0].length;
    return JSON.parse(token[0]) as unknown;
  }
  const result = value(); ws(); if (i !== text.length) fail(); return result;
}
