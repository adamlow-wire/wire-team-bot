import type { GeneralAnswerService, ConversationMemberContext } from "../../ports/GeneralAnswerPort";
import type { WireOutboundPort, OutboundMention } from "../../ports/WireOutboundPort";
import type { QueryAnalysisPort, MemberContext } from "../../ports/QueryAnalysisPort";
import type { RetrievalPort, RetrievalResult, RetrievalScope } from "../../ports/RetrievalPort";
import type { ChannelContext } from "../../ports/ClassifierPort";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Logger } from "../../ports/Logger";

/**
 * Scans `text` for `@Name` tokens and returns Wire mention objects with byte offsets.
 * Only members that have both a name and a domain are eligible.
 */
function extractMentions(text: string, members: ConversationMemberContext[]): OutboundMention[] {
  const mentions: OutboundMention[] = [];
  for (const member of members) {
    if (!member.name || !member.domain) continue;
    const token = `@${member.name}`;
    let idx = text.indexOf(token);
    while (idx !== -1) {
      mentions.push({
        userId: { id: member.id, domain: member.domain },
        offset: idx,
        length: token.length,
      });
      idx = text.indexOf(token, idx + 1);
    }
  }
  return mentions;
}

export interface AnswerQuestionInput {
  question: string;
  conversationContext: string[];
  conversationId: QualifiedId;
  replyToMessageId: string;
  members?: ConversationMemberContext[];
  conversationPurpose?: string;
  /** Phase 3: channel_id string for retrieval scoping. */
  channelId?: string;
  /** Phase 3: Wire domain / org scope for retrieval. */
  orgId?: string;
  /** Phase 3: Defined in personal 1:1 mode — restricts retrieval to user's own entities. */
  userId?: string;
}

/**
 * Answers a general question using the LLM.
 *
 * When queryAnalysis and retrievalEngine are provided (Phase 3):
 *   1. Analyse the question into a QueryPlan via QueryAnalysisPort
 *   2. Run MultiPathRetrievalEngine to gather relevant context
 *   3. Pass retrieval results + complexity to GeneralAnswerService
 *
 * When retrieval engine is absent (backwards-compatible):
 *   - Falls back to empty context (Phase 1b behaviour).
 */
export class AnswerQuestion {
  constructor(
    private readonly generalAnswer: GeneralAnswerService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly queryAnalysis?: QueryAnalysisPort,
    private readonly retrievalEngine?: RetrievalPort,
    private readonly logger?: Logger,
  ) {}

  async execute(input: AnswerQuestionInput): Promise<string> {
    let retrievalResults: RetrievalResult[] = [];
    let complexity = 0.5;

    if (
      this.queryAnalysis &&
      this.retrievalEngine &&
      input.channelId &&
      input.orgId
    ) {
      const channelContext: ChannelContext = {
        channelId: input.channelId,
        purpose: input.conversationPurpose,
      };

      const members: MemberContext[] = (input.members ?? []).map((m) => ({
        id: m.id,
        name: m.name,
      }));

      try {
        const plan = await this.queryAnalysis.analyse(
          input.question,
          channelContext,
          members,
        );
        complexity = plan.complexity;

        const scope: RetrievalScope = {
          organisationId: input.orgId,
          channelId: input.channelId,
          userId: input.userId,
        };

        retrievalResults = await this.retrievalEngine.retrieve(plan, scope);
      } catch (err) {
        // Non-fatal — answer with empty context rather than failing
        this.logger?.warn("AnswerQuestion: retrieval failed, answering with no context", { err: String(err) });
      }
    }

    const answer = await this.generalAnswer.answer(
      input.question,
      input.conversationContext,
      retrievalResults,
      input.members,
      input.conversationPurpose,
      complexity,
    );

    const mentions = extractMentions(answer, input.members ?? []);

    await this.wireOutbound.sendPlainText(input.conversationId, answer, {
      replyToMessageId: input.replyToMessageId,
      mentions: mentions.length > 0 ? mentions : undefined,
    });

    return answer;
  }
}
