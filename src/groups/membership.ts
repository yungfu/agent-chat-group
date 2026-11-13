import { BusinessError } from '../common/errors';
import { Group, GroupsRepository, Participant, ParticipantsRepository } from '../database/repositories';

/** 组必须存在 */
export function requireGroup(groupsRepo: GroupsRepository, groupId: string): Group {
  const group = groupsRepo.findById(groupId);
  if (!group) {
    throw new BusinessError('GROUP_NOT_FOUND', '聊天组不存在或已销毁', { group_id: groupId });
  }
  return group;
}

/** 组必须存在且处于 active 状态（加入与写入类操作） */
export function requireActiveGroup(groupsRepo: GroupsRepository, groupId: string): Group {
  const group = requireGroup(groupsRepo, groupId);
  if (group.status !== 'active') {
    throw new BusinessError('GROUP_CLOSED', '聊天组已关闭，禁止加入或写入', {
      group_id: groupId,
      status: group.status,
    });
  }
  return group;
}

/**
 * 成员参数检查：组存在（按需要求 active）、参与者属于该组且未退出。
 * 必须在事务内调用，与后续写入构成原子检查。
 */
export function requireMember(
  groupsRepo: GroupsRepository,
  participantsRepo: ParticipantsRepository,
  groupId: string,
  participantId: string,
  options: { activeGroup: boolean },
): { group: Group; participant: Participant } {
  const group = options.activeGroup
    ? requireActiveGroup(groupsRepo, groupId)
    : requireGroup(groupsRepo, groupId);
  const participant = participantsRepo.findByIdInGroup(participantId, groupId);
  if (!participant) {
    throw new BusinessError('PARTICIPANT_NOT_FOUND', '参与者不存在或不属于该组', {
      group_id: groupId,
      participant_id: participantId,
    });
  }
  if (participant.leftAt !== null) {
    throw new BusinessError('PARTICIPANT_LEFT', '参与者已退出，不能继续操作', {
      group_id: groupId,
      participant_id: participantId,
    });
  }
  return { group, participant };
}
