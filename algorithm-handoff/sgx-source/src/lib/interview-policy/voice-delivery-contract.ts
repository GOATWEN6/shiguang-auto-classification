/**
 * Pure contract guard for an interview invitation response.
 *
 * This does not send audio or change session state. The Voice layer supplies
 * the delivery state and generation identity; Policy decides what to do with
 * the result. Keeping this guard pure lets offline tests prove that an
 * undelivered or stale invitation cannot enter formal interview mode.
 */

export type InterviewInvitationDeliveryState =
  | 'NOT_SENT'
  | 'SENDING'
  | 'DELIVERED'
  | 'INTERRUPTED'
  | 'CANCELLED'
  | 'FAILED';

export interface InterviewInvitationSnapshot {
  invitationId: string;
  generationId: number;
  deliveryState: InterviewInvitationDeliveryState;
}

export interface InterviewInvitationResponseEvent {
  invitationId: string;
  generationId: number;
  text: string;
}

export type InterviewInvitationResponseDisposition =
  | 'ACCEPT'
  | 'DECLINE'
  | 'CLARIFY'
  | 'IGNORE_STALE';

export interface InterviewInvitationResponseResolution {
  disposition: InterviewInvitationResponseDisposition;
  reasonCode:
    | 'INVITATION_ACCEPTED'
    | 'INVITATION_DECLINED'
    | 'INVITATION_RESPONSE_AMBIGUOUS'
    | 'INVITATION_NOT_DELIVERED'
    | 'INVITATION_STALE_GENERATION';
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

/**
 * Resolve only the delivery/identity precondition. A caller must still pass
 * an ACCEPT result through the normal InterviewPolicy mode-entry rule.
 */
export function resolveInterviewInvitationResponse(
  current: InterviewInvitationSnapshot,
  response: InterviewInvitationResponseEvent,
): InterviewInvitationResponseResolution {
  if (current.invitationId !== response.invitationId || current.generationId !== response.generationId) {
    return { disposition: 'IGNORE_STALE', reasonCode: 'INVITATION_STALE_GENERATION' };
  }
  if (current.deliveryState !== 'DELIVERED') {
    return { disposition: 'CLARIFY', reasonCode: 'INVITATION_NOT_DELIVERED' };
  }
  const text = normalize(response.text);
  if (/^(?:好|可以|愿意|行|那就聊|聊吧|好啊)$/u.test(text)) {
    return { disposition: 'ACCEPT', reasonCode: 'INVITATION_ACCEPTED' };
  }
  if (/^(?:不用|先不聊|暂时不聊|不想聊|不愿意聊|以后再说|先不说|不)$/u.test(text)) {
    return { disposition: 'DECLINE', reasonCode: 'INVITATION_DECLINED' };
  }
  return { disposition: 'CLARIFY', reasonCode: 'INVITATION_RESPONSE_AMBIGUOUS' };
}
