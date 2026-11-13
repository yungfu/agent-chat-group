import { MessageRow, MessagesRepository, MessageType } from '../database/repositories';

export interface ReplyPreview {
  message_id: string;
  sender_id: string | null;
  preview: string;
}

/** 面向 MCP 客户端的消息视图（snake_case，含按读取者派生的字段） */
export interface MessageView {
  message_id: string;
  group_id: string;
  seq: number;
  type: MessageType;
  sender_id: string | null;
  actor_participant_id: string | null;
  text: string;
  payload: unknown;
  mentions: string[];
  reply_to_message_id: string | null;
  reply_to_sender_id: string | null;
  thread_root_message_id: string | null;
  reply_preview: ReplyPreview | null;
  created_at: string;
  is_reply_to_me: boolean;
  is_mentioned: boolean;
}

const PREVIEW_CHARS = 200;

/** 批量构建消息视图：mentions、回复预览、is_reply_to_me / is_mentioned 一次查齐 */
export function buildMessageViews(
  rows: MessageRow[],
  viewerParticipantId: string,
  messagesRepo: MessagesRepository,
): MessageView[] {
  const normalIds = rows.filter((row) => row.type === 'message').map((row) => row.messageId);
  const mentionsMap = messagesRepo.mentionsForMessages(normalIds);

  const replyIds = [
    ...new Set(
      rows.filter((row) => row.replyToMessageId !== null).map((row) => row.replyToMessageId as string),
    ),
  ];
  const targetMap = messagesRepo.findManyById(replyIds);

  return rows.map((row) => {
    const mentions = mentionsMap.get(row.messageId) ?? [];
    const target = row.replyToMessageId ? targetMap.get(row.replyToMessageId) : undefined;
    return {
      message_id: row.messageId,
      group_id: row.groupId,
      seq: row.seq,
      type: row.type,
      sender_id: row.senderId,
      actor_participant_id: row.actorParticipantId,
      text: row.text,
      payload: row.payloadJson === null ? null : JSON.parse(row.payloadJson),
      mentions,
      reply_to_message_id: row.replyToMessageId,
      reply_to_sender_id: target ? target.senderId : null,
      thread_root_message_id: row.threadRootMessageId,
      reply_preview: target
        ? {
            message_id: target.messageId,
            sender_id: target.senderId,
            preview: target.text.slice(0, PREVIEW_CHARS),
          }
        : null,
      created_at: row.createdAt,
      is_reply_to_me: target !== undefined && target.senderId === viewerParticipantId,
      is_mentioned: mentions.includes(viewerParticipantId),
    };
  });
}
