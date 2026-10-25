// Read-only import of the Google Sheet media list via its public CSV export.
// This module only ever issues GET requests: the sheet is never modified.

export interface SheetRow {
  tab: string;
  filename: string;
  titleEn?: string;
  titleFr?: string;
  year?: number;
  folders: string[];
}

/** The sheet's id, from its id or any link to it. */
export function sheetIdFrom(input: string): string {
  const s = input.trim();
  return /\/spreadsheets\/d\/([\w-]+)/.exec(s)?.[1] ?? s;
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Turn one tab's CSV into rows. Tabs either have a "Filename / folder,English title,French title,Year,Folder" header or are a bare filename list. */
export function rowsFromCsv(tab: string, csv: string): SheetRow[] {
  const rows = parseCsv(csv).filter((r) => r.length && (r[0] ?? '').trim());
  if (!rows.length) return [];
  const hasHeader = /^filename/i.test(rows[0]![0]!.trim());
  const data = hasHeader ? rows.slice(1) : rows;
  return data.map((r) => {
    let filename = r[0]!.trim();
    if (r.length >= 4) {
      // Some rows were pasted with the whole record packed into the first cell: "file.avi,EN,FR,2000"
      const packed = ',' + r.slice(1, 4).join(',');
      if (filename.endsWith(packed)) filename = filename.slice(0, -packed.length);
    }
    const year = Number(r[3]);
    return {
      tab,
      filename,
      titleEn: r[1]?.trim() || undefined,
      titleFr: r[2]?.trim() || undefined,
      year: Number.isInteger(year) && year > 1800 ? year : undefined,
      folders: (r[4] ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    };
  });
}

/** Tab names and gids from the sheet's public HTML view. */
export function tabsFromHtml(html: string): Array<{ name: string; gid: string }> {
  const tabs: Array<{ name: string; gid: string }> = [];
  const re = /\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*", gid: "(\d+)"/g;
  for (let m; (m = re.exec(html)); ) tabs.push({ name: JSON.parse(`"${m[1]}"`), gid: m[2]! });
  return tabs;
}

export async function fetchSheet(sheetId: string, fetchFn: typeof fetch = fetch): Promise<SheetRow[]> {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}`;
  const html = await (await fetchFn(`${base}/htmlview`)).text();
  const tabs = tabsFromHtml(html);
  if (!tabs.length) throw new Error('No tabs found: is the sheet shared with "anyone with the link"?');
  const out: SheetRow[] = [];
  for (const { name, gid } of tabs) {
    const res = await fetchFn(`${base}/export?format=csv&gid=${gid}`);
    if (!res.ok) throw new Error(`Sheet tab ${name}: HTTP ${res.status}`);
    out.push(...rowsFromCsv(name, await res.text()));
  }
  return out;
}

/** Key used to join sheet rows with files on disk: lowercased NFC name without a video/subtitle extension. */
export function fileKey(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|mov|m4v|wmv|mpg|mpeg|ts|divx|srt|smi|sub|idx)$/, '');
}
