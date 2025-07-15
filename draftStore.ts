export type DraftData = {
  body: string;
  threadId?: string;
  subject?: string;
  to?: string;
  createdAt: number; // UNIXタイムスタンプ
};

const draftMap: { [userId: string]: { [draftId: string]: DraftData } } = {};

export function generateDraftId(): string {
  return 'draft-' + Math.random().toString(36).substr(2, 9);
}

export function getDrafts(userId: string): { [draftId: string]: DraftData } {
  return draftMap[userId] || {};
}

export function deleteDraft(userId: string, draftId: string): boolean {
  if (draftMap[userId] && draftMap[userId][draftId]) {
    delete draftMap[userId][draftId];
    return true;
  }
  return false;
}

export function setDraft(userId: string, draftId: string, draft: DraftData) {
  if (!draftMap[userId]) draftMap[userId] = {};
  draftMap[userId][draftId] = draft;
}

export function getDraft(userId: string, draftId: string): DraftData | undefined {
  return draftMap[userId]?.[draftId];
} 