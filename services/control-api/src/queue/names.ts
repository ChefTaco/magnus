/** BullMQ rejects colons in queue names. Split the legacy logical name without
 * changing a single Redis key: default "bull:<logical>:<suffix>" stays identical. */
export function bullQueueIdentity(
  namespace: string,
  queue: string,
): { name: string; prefix: string } {
  const logical = namespace + queue,
    index = logical.lastIndexOf(':');
  return index < 0
    ? { name: logical, prefix: 'bull' }
    : { name: logical.slice(index + 1), prefix: 'bull:' + logical.slice(0, index) };
}
