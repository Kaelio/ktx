import { SHAREPOINT_GRAPH_SCOPE, type SharepointDiscoveredDrive, type SharepointDriveItem } from './types.js';

interface GraphClientOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

interface ListDriveFilesOptions {
  driveId: string;
  folderId: string;
  recursive: boolean;
}

export interface ListedDriveFile {
  item: SharepointDriveItem;
  drivePath: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDriveItem(value: unknown): SharepointDriveItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    throw new Error('Microsoft Graph returned an invalid drive item payload');
  }
  const file = isRecord(value.file) ? { mimeType: typeof value.file.mimeType === 'string' ? value.file.mimeType : null } : null;
  const folder = isRecord(value.folder)
    ? { childCount: typeof value.folder.childCount === 'number' ? value.folder.childCount : null }
    : null;
  return {
    id: value.id,
    name: value.name,
    webUrl: typeof value.webUrl === 'string' ? value.webUrl : null,
    lastModifiedDateTime: typeof value.lastModifiedDateTime === 'string' ? value.lastModifiedDateTime : null,
    file,
    folder,
    downloadUrl: typeof value['@microsoft.graph.downloadUrl'] === 'string' ? value['@microsoft.graph.downloadUrl'] : null,
  };
}

export class SharepointGraphClient {
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;

  constructor(private readonly options: GraphClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${this.options.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          scope: SHAREPOINT_GRAPH_SCOPE,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Microsoft Graph token request failed (${response.status} ${response.statusText})`);
    }
    const payload = (await response.json()) as { access_token?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('Microsoft Graph token response did not include access_token');
    }
    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  private async graphJson<T>(url: string): Promise<T> {
    const token = await this.ensureAccessToken();
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Microsoft Graph request failed (${response.status} ${response.statusText}) for ${url}`);
    }
    return (await response.json()) as T;
  }

  private async listChildrenPage(url: string): Promise<{ items: SharepointDriveItem[]; nextLink: string | null }> {
    const payload = await this.graphJson<{ value?: unknown[]; '@odata.nextLink'?: unknown }>(url);
    return {
      items: Array.isArray(payload.value) ? payload.value.map(parseDriveItem) : [],
      nextLink: typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null,
    };
  }

  async listDriveFiles(options: ListDriveFilesOptions): Promise<ListedDriveFile[]> {
    const listed: ListedDriveFile[] = [];
    await this.walkFolder(
      options.driveId,
      `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(options.driveId)}/items/${encodeURIComponent(options.folderId)}/children?$top=200`,
      options.recursive,
      [],
      listed,
    );
    return listed;
  }

  private async walkFolder(
    driveId: string,
    url: string,
    recursive: boolean,
    parents: string[],
    out: ListedDriveFile[],
  ): Promise<void> {
    let nextLink: string | null = url;
    while (nextLink) {
      const page = await this.listChildrenPage(nextLink);
      for (const item of page.items) {
        if (item.folder) {
          if (recursive) {
            await this.walkFolder(
              driveId,
              `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/children?$top=200`,
              true,
              [...parents, item.name],
              out,
            );
          }
          continue;
        }
        out.push({ item, drivePath: parents });
      }
      nextLink = page.nextLink;
    }
  }

  async getDriveItem(driveId: string, itemId: string): Promise<SharepointDriveItem> {
    return parseDriveItem(
      await this.graphJson(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`),
    );
  }

  async downloadFile(driveId: string, item: SharepointDriveItem): Promise<Buffer> {
    const token = await this.ensureAccessToken();
    const response = await this.fetchImpl(
      item.downloadUrl ?? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content`,
      {
        headers: item.downloadUrl ? undefined : { authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Microsoft Graph download failed (${response.status} ${response.statusText}) for ${item.name}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listDrivesForSite(siteId: string): Promise<SharepointDiscoveredDrive[]> {
    const drives: SharepointDiscoveredDrive[] = [];
    let nextLink: string | null = `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drives?$top=200`;
    while (nextLink) {
      const payload: { value?: unknown[]; '@odata.nextLink'?: unknown } = await this.graphJson(nextLink);
      if (Array.isArray(payload.value)) {
        for (const candidate of payload.value) {
          if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.name !== 'string') {
            continue;
          }
          drives.push({
            id: candidate.id,
            name: candidate.name,
            webUrl: typeof candidate.webUrl === 'string' ? candidate.webUrl : null,
          });
        }
      }
      nextLink = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null;
    }
    return drives;
  }
}

export function createSharepointGraphClient(options: GraphClientOptions): SharepointGraphClient {
  return new SharepointGraphClient(options);
}
