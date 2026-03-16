/**
 * StartInfinity API Client
 *
 * Thin wrapper around StartInfinity REST API v2.
 * Docs: https://app.startinfinity.com/api/v2
 * Rate limit: 180 req/min — batch calls include a small delay.
 */

const BASE_URL = "https://app.startinfinity.com/api/v2";
const BATCH_DELAY_MS = 400; // ~150 req/min safe margin

// ============================================================
// TYPES
// ============================================================

export interface Workspace {
  id: string;
  name: string;
}

export interface Board {
  id: string;
  name: string;
  workspace_id: string;
}

export interface Folder {
  id: string;
  name: string;
  board_id: string;
  color?: string;
}

export interface Attribute {
  id: string;
  name: string;
  type: string;
  board_id: string;
}

export interface AttributeInput {
  name: string;
  type: "text" | "number" | "longtext" | "date" | "select" | "checkbox";
}

export interface Item {
  id: string;
  name: string;
  folder_id: string;
  board_id: string;
  values?: AttributeValue[];
}

export interface AttributeValue {
  attribute_id: string;
  data: string | number | null;
}

export interface CreateItemInput {
  name: string;
  folder_id: string;
  values?: Array<{ attribute_id: string; data: string | number }>;
}

// ============================================================
// CLIENT
// ============================================================

export class StartInfinityClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(no body)");
      throw new Error(`StartInfinity API ${method} ${path} → ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    return data as T;
  }

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  // ---- Discovery ----

  async getWorkspaces(): Promise<Workspace[]> {
    const data = await this.request<{ data: Workspace[] }>("GET", "/workspaces");
    return data.data ?? [];
  }

  async getBoards(workspaceId: string): Promise<Board[]> {
    const data = await this.request<{ data: Board[] }>(
      "GET",
      `/workspaces/${workspaceId}/boards`
    );
    return data.data ?? [];
  }

  async getFolders(workspaceId: string, boardId: string): Promise<Folder[]> {
    const data = await this.request<{ data: Folder[] }>(
      "GET",
      `/workspaces/${workspaceId}/boards/${boardId}/folders`
    );
    return data.data ?? [];
  }

  async getAttributes(workspaceId: string, boardId: string): Promise<Attribute[]> {
    const data = await this.request<{ data: Attribute[] }>(
      "GET",
      `/workspaces/${workspaceId}/boards/${boardId}/attributes`
    );
    return data.data ?? [];
  }

  // ---- Items ----

  async getItems(
    workspaceId: string,
    boardId: string,
    opts: { folder_id?: string } = {}
  ): Promise<Item[]> {
    const params = new URLSearchParams({ "expand[]": "values" });
    if (opts.folder_id) params.set("folder_id", opts.folder_id);
    const data = await this.request<{ data: Item[] }>(
      "GET",
      `/workspaces/${workspaceId}/boards/${boardId}/items?${params}`
    );
    return data.data ?? [];
  }

  async createItem(
    workspaceId: string,
    boardId: string,
    input: CreateItemInput
  ): Promise<Item> {
    const data = await this.request<Item>(
      "POST",
      `/workspaces/${workspaceId}/boards/${boardId}/items`,
      input
    );
    await this.delay();
    return data;
  }

  async updateItem(
    workspaceId: string,
    boardId: string,
    itemId: string,
    input: Partial<CreateItemInput>
  ): Promise<Item> {
    const data = await this.request<Item>(
      "PUT",
      `/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
      input
    );
    await this.delay();
    return data;
  }

  // ---- Board setup ----

  async createBoard(workspaceId: string, name: string): Promise<Board> {
    const data = await this.request<Board>(
      "POST",
      `/workspaces/${workspaceId}/boards`,
      { name }
    );
    await this.delay();
    return data;
  }

  async createFolder(
    workspaceId: string,
    boardId: string,
    name: string
  ): Promise<Folder> {
    const data = await this.request<Folder>(
      "POST",
      `/workspaces/${workspaceId}/boards/${boardId}/folders`,
      { name }
    );
    await this.delay();
    return data;
  }

  async createAttribute(
    workspaceId: string,
    boardId: string,
    attr: AttributeInput
  ): Promise<Attribute> {
    const data = await this.request<Attribute>(
      "POST",
      `/workspaces/${workspaceId}/boards/${boardId}/attributes`,
      attr
    );
    await this.delay();
    return data;
  }
}
