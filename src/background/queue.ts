// One queue per service-worker instance. Rejections never poison later work.
let queue = Promise.resolve();
export function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

