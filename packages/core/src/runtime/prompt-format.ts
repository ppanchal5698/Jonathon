/**
 * Prompt layout shared by the answering/extraction services (writers) and the demo runtime (reader).
 * Client text is fenced in tagged blocks and neutralised so it cannot close a block or forge one.
 */

export interface PromptEvidence {
  id: string; // E1, E2, ...
  authority: string;
  title: string;
  locator: string;
  text: string;
}

/** Prevent client text from closing or opening Jonathon's tags. */
export function fence(text: string): string {
  return text.replace(/<\/?\s*(evidence|history|question|turn|instructions)\b[^>]*>/gi, (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
}

function attr(s: string): string {
  return s.replace(/["<>\n\r]/g, " ").slice(0, 300);
}

export function renderEvidence(items: PromptEvidence[]): string {
  return items
    .map(
      (e) =>
        `<evidence id="${attr(e.id)}" authority="${attr(e.authority)}" title="${attr(e.title)}" locator="${attr(e.locator)}">\n${fence(e.text)}\n</evidence>`,
    )
    .join("\n\n");
}

export function parseEvidence(prompt: string): PromptEvidence[] {
  const out: PromptEvidence[] = [];
  const re = /<evidence id="([^"]*)" authority="([^"]*)" title="([^"]*)" locator="([^"]*)">\n([\s\S]*?)\n<\/evidence>/g;
  let m: RegExpExecArray | null = re.exec(prompt);
  while (m) {
    out.push({ id: m[1]!, authority: m[2]!, title: m[3]!, locator: m[4]!, text: m[5]! });
    m = re.exec(prompt);
  }
  return out;
}

export function parseQuestion(prompt: string): string {
  return /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt)?.[1]?.trim() ?? "";
}
