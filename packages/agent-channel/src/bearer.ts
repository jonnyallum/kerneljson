/** Room bearers are a different audience from admission-door bearers. The door rejects this prefix. */
export const ROOM_BEARER_PREFIX = "kjr1_";
const ROOM_BEARER = /^kjr1_[A-Za-z0-9_-]{27,}$/;

export function isRoomBearer(token: string): boolean {
  return ROOM_BEARER.test(token);
}
