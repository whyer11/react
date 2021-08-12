/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {UpdateQueue as HookQueue} from './ReactFiberHooks.new';
import type {SharedQueue as ClassQueue} from './ReactUpdateQueue.new';

// An array of all update queues that received updates during the current
// render. When this render exits, either because it finishes or because it is
// interrupted, the interleaved updates will be transfered onto the main part
// of the queue.
let interleavedQueues: Array<
  HookQueue<any, any> | ClassQueue<any>,
> | null = null;

/**
 * 这个方法被enqueueUpdate使用,就是判断 被排队的fiber的shared中有没有interleaved的update,
 * 如果有的话,就直接push进来,不做任何处理.
 *
 * 这里就是在组件更新的过程中用户又进行了操作,然后就累积在这里,当一次更新结束之后,再把interleaved
 * merge到pending里面去,这样下一次pending中就有update了.
 * @param queue
 */
export function pushInterleavedQueue(
  queue: HookQueue<any, any> | ClassQueue<any>,
) {
  if (interleavedQueues === null) {
    interleavedQueues = [queue];
  } else {
    interleavedQueues.push(queue);
  }
}

export function enqueueInterleavedUpdates() {
  /**
   * 直译:
   *  将交错的更新转移到主队列。每个队列有一个`pending`字段和一个`interleaved`字段。当它们不
   *  为空时，它们指向循环链接列表中的最后一个节点。我们需要将交错的列表追加到待定列表的末尾，将
   *  它们连接成一个单一的循环列表。
   *
   *  判断一把interleavedQueues是不是空的,不是空就循环.因为上面一个方法就是在往这个数组里面插入一个个queue,
   *  首先明确的是 interleavedQueues 这个玩意是个 Array<UpdateQueue>
   *  所以拿到了一个个queue之后,就取queue中的interleaved,这个是链表中的最后一个,然后一切建立在
   *  lastInterleavedUpdate 不等于null
   *  进if 就把当前循环到的queue置为null,表示当前的这个interleaved我清空了
   *  然后再找queue的pending
   *
   *  firstPending -> 2 -> 3 -> lastPending
   *  ^---------------------------|
   *
   *  firstInterleaved -> 2 -> 3 -> lastInterleaved
   *  ^--------------------------------|
   *
   *
   *  firstPending -> 2 -> 3 -> lastPending -> firstInterleaved -> 2 -> 3 -> lastInterleaved
   *  ^--------------------------------------------------------------------------|
   *
   *  把interleaved 拼在了pending上
   *  最后再把pending指向 lastInterleaved
   *  wow ....
   *
   *  然后这个方法在哪里使用了呢? prepareFreshStack 这个方法,这个方法又再哪里使用呢 自己搜吧
   *
   */
  // Transfer the interleaved updates onto the main queue. Each queue has a
  // `pending` field and an `interleaved` field. When they are not null, they
  // point to the last node in a circular linked list. We need to append the
  // interleaved list to the end of the pending list by joining them into a
  // single, circular list.
  if (interleavedQueues !== null) {
    for (let i = 0; i < interleavedQueues.length; i++) {
      const queue = interleavedQueues[i];
      const lastInterleavedUpdate = queue.interleaved;
      if (lastInterleavedUpdate !== null) {
        queue.interleaved = null;
        const firstInterleavedUpdate = lastInterleavedUpdate.next;
        const lastPendingUpdate = queue.pending;
        if (lastPendingUpdate !== null) {
          const firstPendingUpdate = lastPendingUpdate.next;
          lastPendingUpdate.next = (firstInterleavedUpdate: any);
          lastInterleavedUpdate.next = (firstPendingUpdate: any);
        }
        queue.pending = (lastInterleavedUpdate: any);
      }
    }
    interleavedQueues = null;
  }
}
