import type {
  ChannelConfig,
  ChannelConfigRepository,
  ChannelState,
  SecureRange,
} from "../../../domain/repositories/ChannelConfigRepository";
import { getPrismaClient } from "./PrismaClient";

function toChannelConfig(row: {
  channelId: string;
  channelName: string | null;
  organisationId: string;
  state: string;
  stateChangedAt: Date | null;
  stateChangedBy: string | null;
  purpose: string | null;
  contextType: string | null;
  tags: string[];
  stakeholders: string[];
  relatedChannels: string[];
  contextUpdatedAt: Date | null;
  contextUpdatedBy: string | null;
  secureRanges: unknown;
  timezone: string;
  locale: string;
  joinedAt: Date | null;
  isPersonalMode: boolean;
}): ChannelConfig {
  const raw = Array.isArray(row.secureRanges) ? row.secureRanges : [];
  const secureRanges: SecureRange[] = (raw as Array<{ start: string; end: string | null }>).map((r) => ({
    start: new Date(r.start),
    end: r.end ? new Date(r.end) : null,
  }));

  return {
    channelId: row.channelId,
    channelName: row.channelName ?? undefined,
    organisationId: row.organisationId,
    state: row.state as ChannelState,
    stateChangedAt: row.stateChangedAt ?? undefined,
    stateChangedBy: row.stateChangedBy ?? undefined,
    purpose: row.purpose ?? undefined,
    contextType: row.contextType as ChannelConfig["contextType"],
    tags: row.tags,
    stakeholders: row.stakeholders,
    relatedChannels: row.relatedChannels,
    contextUpdatedAt: row.contextUpdatedAt ?? undefined,
    contextUpdatedBy: row.contextUpdatedBy ?? undefined,
    secureRanges,
    timezone: row.timezone,
    locale: row.locale,
    joinedAt: row.joinedAt ?? undefined,
    isPersonalMode: row.isPersonalMode,
  };
}

export class PrismaChannelConfigRepository implements ChannelConfigRepository {
  private readonly prisma = getPrismaClient();

  async get(channelId: string): Promise<ChannelConfig | null> {
    const row = await this.prisma.channelConfig.findUnique({ where: { channelId } });
    if (!row) return null;
    return toChannelConfig(row);
  }

  async upsert(config: ChannelConfig): Promise<ChannelConfig> {
    const secureRanges = config.secureRanges.map((r) => ({
      start: r.start.toISOString(),
      end: r.end ? r.end.toISOString() : null,
    }));

    await this.prisma.channelConfig.upsert({
      where: { channelId: config.channelId },
      create: {
        channelId: config.channelId,
        channelName: config.channelName ?? null,
        organisationId: config.organisationId,
        state: config.state,
        stateChangedAt: config.stateChangedAt ?? null,
        stateChangedBy: config.stateChangedBy ?? null,
        purpose: config.purpose ?? null,
        contextType: config.contextType ?? null,
        tags: config.tags ?? [],
        stakeholders: config.stakeholders ?? [],
        relatedChannels: config.relatedChannels ?? [],
        contextUpdatedAt: config.contextUpdatedAt ?? null,
        contextUpdatedBy: config.contextUpdatedBy ?? null,
        secureRanges: secureRanges as object[],
        timezone: config.timezone,
        locale: config.locale,
        joinedAt: config.joinedAt ?? null,
        isPersonalMode: config.isPersonalMode ?? false,
      },
      update: {
        channelName: config.channelName ?? null,
        state: config.state,
        stateChangedAt: config.stateChangedAt ?? null,
        stateChangedBy: config.stateChangedBy ?? null,
        purpose: config.purpose ?? null,
        contextType: config.contextType ?? null,
        tags: config.tags ?? [],
        stakeholders: config.stakeholders ?? [],
        relatedChannels: config.relatedChannels ?? [],
        contextUpdatedAt: config.contextUpdatedAt ?? null,
        contextUpdatedBy: config.contextUpdatedBy ?? null,
        secureRanges: secureRanges as object[],
        timezone: config.timezone,
        locale: config.locale,
        isPersonalMode: config.isPersonalMode ?? false,
      },
    });

    return config;
  }

  async setState(channelId: string, state: ChannelState, changedBy: string, now: Date): Promise<void> {
    await this.prisma.channelConfig.updateMany({
      where: { channelId },
      data: { state, stateChangedAt: now, stateChangedBy: changedBy },
    });
  }

  async openSecureRange(channelId: string, start: Date): Promise<void> {
    const row = await this.prisma.channelConfig.findUnique({ where: { channelId } });
    const existing: Array<{ start: string; end: string | null }> = Array.isArray(row?.secureRanges)
      ? (row.secureRanges as Array<{ start: string; end: string | null }>)
      : [];
    existing.push({ start: start.toISOString(), end: null });
    await this.prisma.channelConfig.updateMany({
      where: { channelId },
      data: { secureRanges: existing as object[] },
    });
  }

  async closeSecureRange(channelId: string, end: Date): Promise<void> {
    const row = await this.prisma.channelConfig.findUnique({ where: { channelId } });
    const existing: Array<{ start: string; end: string | null }> = Array.isArray(row?.secureRanges)
      ? (row.secureRanges as Array<{ start: string; end: string | null }>)
      : [];
    // Close the most recent open range
    const lastOpen = [...existing].reverse().find((r) => r.end === null);
    if (lastOpen) {
      lastOpen.end = end.toISOString();
    }
    await this.prisma.channelConfig.updateMany({
      where: { channelId },
      data: { secureRanges: existing as object[] },
    });
  }

  async listByState(state: ChannelState): Promise<ChannelConfig[]> {
    const rows = await this.prisma.channelConfig.findMany({ where: { state } });
    return rows.map(toChannelConfig);
  }
}
