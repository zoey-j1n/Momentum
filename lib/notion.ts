// Notion: one meeting page per posted invite (decision #18). The v1 createMeetingPage, behind an interface
// so the handler can be tested with a fake, plus a title lookup so a retried job reuses the page it
// already made instead of creating a second one.
import { Client } from "@notionhq/client";

export type MeetingPageInput = { title: string; notes: string; requestedBy: string };

export interface NotionClient {
  findMeetingPage(title: string): Promise<string | null>; // URL of an existing page with this title, or null
  createMeetingPage(input: MeetingPageInput): Promise<string>; // URL of the new page
}

export function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
}

export class RealNotionClient implements NotionClient {
  private client: Client;
  private databaseId: string;
  private titleProperty: string;
  private dataSourceId?: string;

  constructor() {
    const key = process.env.NOTION_API_KEY;
    const db = process.env.NOTION_DATABASE_ID;
    if (!key || !db) throw new Error("NOTION_API_KEY and NOTION_DATABASE_ID must be set");
    this.client = new Client({ auth: key, timeoutMs: 10_000 });
    this.databaseId = db;
    this.titleProperty = process.env.NOTION_TITLE_PROPERTY ?? "Name";
  }

  // Notion's 2025 API queries a database through its data source. Resolve it once.
  private async dataSource(): Promise<string> {
    if (this.dataSourceId) return this.dataSourceId;
    const db = (await this.client.databases.retrieve({ database_id: this.databaseId })) as { data_sources?: { id: string }[] };
    const id = db.data_sources?.[0]?.id;
    if (!id) throw new Error("Notion database has no data source (is the integration connected to it?)");
    this.dataSourceId = id;
    return id;
  }

  async findMeetingPage(title: string): Promise<string | null> {
    const res = await this.client.dataSources.query({
      data_source_id: await this.dataSource(),
      filter: { property: this.titleProperty, title: { equals: title } },
      page_size: 1,
    });
    const page = res.results[0] as { url?: string; id: string } | undefined;
    return page ? (page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`) : null;
  }

  async createMeetingPage(input: MeetingPageInput): Promise<string> {
    const page = (await this.client.pages.create({
      parent: { database_id: this.databaseId },
      properties: { [this.titleProperty]: { title: [{ text: { content: input.title } }] } },
      children: [
        { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: `Requested by: ${input.requestedBy}` } }] } },
        { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: input.notes.slice(0, 2000) } }] } },
      ],
    })) as { url?: string; id: string };
    return page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`;
  }
}

export class FakeNotionClient implements NotionClient {
  pages = new Map<string, string>(); // title -> url
  created: MeetingPageInput[] = [];
  async findMeetingPage(title: string) { return this.pages.get(title) ?? null; }
  async createMeetingPage(input: MeetingPageInput) {
    this.created.push(input);
    const url = `https://notion.so/fake-${this.created.length}`;
    this.pages.set(input.title, url);
    return url;
  }
}
