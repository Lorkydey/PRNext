// One owned task per router; replaced navigations release their original link.
const tasks = new WeakMap();
export function beginNavigationTask(router, token) {
  cancelNavigationTask(router);
  let resolve;
  const task = { token, settled: false, promise: new Promise(done => { resolve = done; }) };
  task.finish = committed => {
    if (task.settled) return;
    task.settled = true;
    if (tasks.get(router) === task) tasks.delete(router);
    resolve(committed);
  };
  tasks.set(router, task);
  return task;
}
export function currentNavigationTask(router) { return tasks.get(router); }
export function cancelNavigationTask(router) { tasks.get(router)?.finish(false); }
