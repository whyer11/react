/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {Lanes, Lane} from './ReactFiberLane.new';

import {
  NoLane,
  NoLanes,
  isSubsetOfLanes,
  mergeLanes,
  isTransitionLane,
  intersectLanes,
  markRootEntangled,
} from './ReactFiberLane.new';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext.new';
import {Callback, ShouldCapture, DidCapture} from './ReactFiberFlags';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictLegacyMode} from './ReactTypeOfMode';
import {
  markSkippedUpdateLanes,
  isInterleavedUpdate,
} from './ReactFiberWorkLoop.new';
import {pushInterleavedQueue} from './ReactFiberInterleavedUpdates.new';

import invariant from 'shared/invariant';

import {disableLogs, reenableLogs} from 'shared/ConsolePatchingDev';

export type Update<State> = {|
  // TODO: Temporary field. Will remove this by storing a map of
  // transition -> event time on the root.
  eventTime: number,
  /**
   * 这里的Lane 和下面的Lanes的关系是一个松散的从属关系
   */
  lane: Lane,

  tag: 0 | 1 | 2 | 3,
  payload: any,
  callback: (() => mixed) | null,

  next: Update<State> | null,
|};

export type SharedQueue<State> = {|
  pending: Update<State> | null,
  interleaved: Update<State> | null,
  lanes: Lanes,
|};

export type UpdateQueue<State> = {|
  baseState: State,
  firstBaseUpdate: Update<State> | null,
  lastBaseUpdate: Update<State> | null,
  shared: SharedQueue<State>,
  effects: Array<Update<State>> | null,
|};

export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

/**
 * 传入一个Fiber,然后构造一个updateQueue
 * 好的这里看到了base 和 pending了.就是在更新状态的时候用来比较的状态
 * 然后把这个queue 挂载到updateQueue上,
 * 这个Fiber呢也是一个root fiber就是一个react的入口 万物基于此
 * @param fiber
 */
export function initializeUpdateQueue<State>(fiber: Fiber): void {
  const queue: UpdateQueue<State> = {
    baseState: fiber.memoizedState,
    firstBaseUpdate: null,
    lastBaseUpdate: null,
    shared: {
      pending: null,
      interleaved: null,
      lanes: NoLanes,
    },
    effects: null,
  };
  fiber.updateQueue = queue;
}

export function cloneUpdateQueue<State>(
  current: Fiber,
  workInProgress: Fiber,
): void {
  // Clone the update queue from current. Unless it's already a clone.
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
  if (queue === currentQueue) {
    const clone: UpdateQueue<State> = {
      baseState: currentQueue.baseState,
      firstBaseUpdate: currentQueue.firstBaseUpdate,
      lastBaseUpdate: currentQueue.lastBaseUpdate,
      shared: currentQueue.shared,
      effects: currentQueue.effects,
    };
    workInProgress.updateQueue = clone;
  }
}

export function createUpdate(eventTime: number, lane: Lane): Update<*> {
  const update: Update<*> = {
    eventTime,
    lane,

    tag: UpdateState,
    payload: null,
    callback: null,

    next: null,
  };
  return update;
}

export function enqueueUpdate<State>(
  fiber: Fiber,
  update: Update<State>,
  lane: Lane,
) {
  /**
   * 从fiber中取了updateQueue, 这updateQueue哪里来的..
   * TODO
   * 先不管这个updateQueue哪里来的,总之在processUpdate的时候 处理的就是这个updateQueue.
   * 这个updateQueue是createFiberRoot的时候初始化的
   * 第一次渲染的时候,这个时候的Fiber的stateNode就是FiberRoot.
   *
   * @type {*}
   */
  const updateQueue = fiber.updateQueue;
  /**
   * 如果是空的话 就直接返回.为啥,这不是拿着fiber和update来排队的吗?
   * updateQueue确实会为空,直接return undefined也没有问题
   */
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return;
  }
  /**
   * 又从updateDate中取shared了,这里看着有点眼熟,因为processUpdateQueue中的pendingQueue就来自于
   * shared
   * @type {SharedQueue<State>|*}
   */
  const sharedQueue: SharedQueue<State> = (updateQueue: any).shared;
  /**
   * 就判断一下是不是可打断的fiber
   */
  if (isInterleavedUpdate(fiber, lane)) {
    /**
     * 这里的sharedQueue 具备 pending interleaved lanes 三个字段, pending的意思就是当前等待的updates
     * 这里取interleaved这个字段说实话不知道是干啥的
     * @type {Update<State>|Update<State>|*}
     */
    const interleaved = sharedQueue.interleaved;
    if (interleaved === null) {
      /**
       * 先自己的next等于自己拼成一个环
       * @type {Update<State>}
       */
      // This is the first update. Create a circular list.
      update.next = update;
      /**
       * 把一个sharedQueue推入 interleavedQueues的数组中,具体干啥的不知道
       * 好的这个时候知道了,就是发现shared里面有interleaved了.然后赶紧往公共的interleavedQueues中塞,
       * 然后这次就先不更新他了
       */
      // At the end of the current render, this queue's interleaved updates will
      // be transfered to the pending queue.
      pushInterleavedQueue(sharedQueue);
    } else {
      /**
       * 果然链表操作就很难 这里就是把interleaved的next同步给update,
       * @type {Update<State>|*}
       */
      update.next = interleaved.next;
      /**
       * 再把当前的update作为interleaved的下一个节点,这样的每次进来interleaved都会将新节点添加到自己的链表中.
       * @type {Update<State>}
       */
      interleaved.next = update;
    }
    /**
     * 每次都会将新来的update赋值到interleaved,前面又会把上一个update的next 赋值给当前的update的next
     * update    update.next     interleaved  interleaved.next
     * 1            1                     1           1
     * 2            1                                 2
     * 3            2                                 3
     * @type {Update<State>}
     */
    sharedQueue.interleaved = update;

    /**
     * 直到这个if结束我也没看懂这是在干什么.总结一下就是判断一下是不是一个"交错"的update,如果是的话往 shared 的interleaved上拼.
     * 但是后面的process中没有用到这个interleaved...好奇怪
     * TODO
     */
  } else {
    /**
     * 这个else 就正常了一点,是把每一个新来的update往pending上面拼.这个拼完之后processUpdateQueue
     * 就消费了这个pending,最终得到新的状态.
     * @type {Update<State>|Update<State>|*}
     */
    const pending = sharedQueue.pending;
    if (pending === null) {
      // This is the first update. Create a circular list.
      update.next = update;
    } else {
      update.next = pending.next;
      pending.next = update;
    }
    sharedQueue.pending = update;
  }

  if (__DEV__) {
    if (
      currentlyProcessingQueue === sharedQueue &&
      !didWarnUpdateInsideUpdate
    ) {
      console.error(
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      didWarnUpdateInsideUpdate = true;
    }
  }
}

export function entangleTransitions(root: FiberRoot, fiber: Fiber, lane: Lane) {
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // Only occurs if the fiber has been unmounted.
    return;
  }

  const sharedQueue: SharedQueue<mixed> = (updateQueue: any).shared;
  if (isTransitionLane(lane)) {
    let queueLanes = sharedQueue.lanes;

    // If any entangled lanes are no longer pending on the root, then they must
    // have finished. We can remove them from the shared queue, which represents
    // a superset of the actually pending lanes. In some cases we may entangle
    // more than we need to, but that's OK. In fact it's worse if we *don't*
    // entangle when we should.
    queueLanes = intersectLanes(queueLanes, root.pendingLanes);

    // Entangle the new transition lane with the other transition lanes.
    const newQueueLanes = mergeLanes(queueLanes, lane);
    sharedQueue.lanes = newQueueLanes;
    // Even if queue.lanes already include lane, we don't know for certain if
    // the lane finished since the last time we entangled it. So we need to
    // entangle it again, just to be sure.
    markRootEntangled(root, newQueueLanes);
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  capturedUpdate: Update<State>,
) {
  // Captured updates are updates that are thrown by a child during the render
  // phase. They should be discarded if the render is aborted. Therefore,
  // we should only put them on the work-in-progress queue, not the current one.
  let queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  // Check if the work-in-progress queue is a clone.
  const current = workInProgress.alternate;
  if (current !== null) {
    const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
    if (queue === currentQueue) {
      // The work-in-progress queue is the same as current. This happens when
      // we bail out on a parent fiber that then captures an error thrown by
      // a child. Since we want to append the update only to the work-in
      // -progress queue, we need to clone the updates. We usually clone during
      // processUpdateQueue, but that didn't happen in this case because we
      // skipped over the parent when we bailed out.
      let newFirst = null;
      let newLast = null;
      const firstBaseUpdate = queue.firstBaseUpdate;
      if (firstBaseUpdate !== null) {
        // Loop through the updates and clone them.
        let update = firstBaseUpdate;
        do {
          const clone: Update<State> = {
            eventTime: update.eventTime,
            lane: update.lane,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          if (newLast === null) {
            newFirst = newLast = clone;
          } else {
            newLast.next = clone;
            newLast = clone;
          }
          update = update.next;
        } while (update !== null);

        // Append the captured update the end of the cloned list.
        if (newLast === null) {
          newFirst = newLast = capturedUpdate;
        } else {
          newLast.next = capturedUpdate;
          newLast = capturedUpdate;
        }
      } else {
        // There are no base updates.
        newFirst = newLast = capturedUpdate;
      }
      queue = {
        baseState: currentQueue.baseState,
        firstBaseUpdate: newFirst,
        lastBaseUpdate: newLast,
        shared: currentQueue.shared,
        effects: currentQueue.effects,
      };
      workInProgress.updateQueue = queue;
      return;
    }
  }

  // Append the update to the end of the list.
  const lastBaseUpdate = queue.lastBaseUpdate;
  if (lastBaseUpdate === null) {
    queue.firstBaseUpdate = capturedUpdate;
  } else {
    lastBaseUpdate.next = capturedUpdate;
  }
  queue.lastBaseUpdate = capturedUpdate;
}

function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  switch (update.tag) {
    /**
     * 先不管这个tag是啥意思,看内容
     * 判断payload是不是函数,函数的话执行函数,把 instance, prevState, nextProps 这三样传进去
     * 就是我们再 this.setState(()=>{}) 的时候调用的
     * 如果不是函数 就直接返回payload
     */
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
        }
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            disableLogs();
            try {
              payload.call(instance, prevState, nextProps);
            } finally {
              reenableLogs();
            }
          }
          exitDisallowedContextReadInDEV();
        }
        return nextState;
      }
      // State object
      return payload;
    }
    /**
     * 这个也不知道啥意思,给当前工作的fiber的flags赋值,
     */
    case CaptureUpdate: {
      workInProgress.flags =
        /**
         * 用当前的flags 与  shouldCapture的补码.. 0b00000000100000000000000
         *                                        11111111011111111111111
         *                                        11111111100000000000000
         *
         * 与完了之后再和 DidCapture 或...         0b00000000000000010000000
         *                                        11111111100000010000000
         *
         * 上面都是我瞎扯 TODO 我不知道这段啥意思
         */
        (workInProgress.flags & ~ShouldCapture) | DidCapture;
    }
    /**
     * 这个就好理解一点了,拿到一次update的payload,然后是函数就运行是object就直接取,最后再Object.assign一把
     * 如果啥也不是就返回参数中的状态
     */
    // Intentional fallthrough
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
        }
        partialState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictLegacyMode
          ) {
            disableLogs();
            try {
              payload.call(instance, prevState, nextProps);
            } finally {
              reenableLogs();
            }
          }
          exitDisallowedContextReadInDEV();
        }
      } else {
        // Partial state object
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Merge the partial state and the previous state.
      return Object.assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

/**
 * 这个方法与外部调用的fiber紧密相连,所以第一个参数就是一个Fiber,先抛开fiber的具体实现,直接看
 * 这个处理逻辑
 */
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderLanes: Lanes,
): void {
  /**
   * updateQueue我的理解是具体某一个组件的状态update处理过程,接受schedule的统一调度
   * schedule->fiber->update
   * 这里拿到一个fiber实例中挂在的更新队列,这个队列实际上是一个环状链表
   *
   * export type UpdateQueue<State> = {|
      baseState: State,
      firstBaseUpdate: Update<State> | null,
      lastBaseUpdate: Update<State> | null,
      shared: SharedQueue<State>,
      effects: Array<Update<State>> | null,
    |};
   * UpdateQueue 类型中要注意的是 shared字段,是一个SharedQueue
   */
  // This is always non-null on a ClassComponent or HostRoot
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  /**
   * 标记当前是不是强制更新,这里 TODO 并不知道用在了哪里
   * @type {boolean}
   */
  hasForceUpdate = false;

  if (__DEV__) {
    currentlyProcessingQueue = queue.shared;
  }
  /**
   * 获取第一个没有被更新的的update,获取最后一个没有被更新的update,这里根据各种文章讲说是上一次
   * 没有被更新的update,存了一个头和一个尾这样就可以拼接在这次的处理过程中
   * 我的疑问是这个first和last怎么就能保证他们是相连的?也是当前的这个函数设置的?看起来并不是,因为
   * 当前的函数只处理某一个fiber带来的update. 先 TODO 看看上一次剩下的update到底怎么被初始化的为什么可以保证是连续的.
   * @type {Update<State>|null|*}
   */
  let firstBaseUpdate = queue.firstBaseUpdate;
  let lastBaseUpdate = queue.lastBaseUpdate;
  /**
   * pending是一个UpdateQueue shared字段中的定义,看这个名字应该是当前等待的update,这让我
   * 疑惑了起来,这是个什么样的调度逻辑?上面是first last 表示没有被更新的,这里又来个pending.
   * TODO 这个pending中的update 和 first last表示的update队列有啥关系.
   * 总之这里就是把链表的一个节点赋给一个变量,然后判断一下如果不是空的就把自己置为空
   * @type {SharedQueue<State>|*}
   */
  // Check if there are pending updates. If so, transfer them to the base queue.
  let pendingQueue = queue.shared.pending;
  if (pendingQueue !== null) {
    /**
     * 赋值为null的行为并不会导致pendingQueue的值发生变化,因为只是变量中存储的内存地址变化了不会
     * 导致那个内存地址执行的内容变化.要想其变化,还是得直接修改
     * TODO 为啥要置为null, 不知道,但是是直接修改了当前的这个fiber中的updateQueue的内容.
     * @type {null}
     */
    queue.shared.pending = null;

    /**
     * pendingQueue指向的被认为是最后一个update节点,众所周知updateQueue是一个环状的链表
     * 所以取其next得到第一个update.
     * @type {SharedQueue<State>|*}
     */

    // The pending queue is circular. Disconnect the pointer between first
    // and last so that it's non-circular.
    const lastPendingUpdate = pendingQueue;
    const firstPendingUpdate = lastPendingUpdate.next;
    /**
     * 取到firstPending之后,把这个环给拆了,
     * @type {null}
     */
    lastPendingUpdate.next = null;
    /**
     * 上面的lastBaseUpdate判断一下是不是空,如果是的话就把firstBaseUpdate 置为 firstPendingUpdate
     * 这里有了上面 firstBase 和 lastBase的赋值操作, 最后一个没有被更新的update如果是null的话
     * 就把firstBase置为firstPending ,如果不空的话就把lastBase的next置为firstPending
     * 众所周知,lastBase.next 就是 firstBase.
     *
     * 这里的注释是把pendingUpdate 添加到 BaseUpdate queue中
     *
     *
     * 这里可以这么理解,如果lastBase是个空的话,那么当前这个base其实是不是一个链表,lastBase是空
     * firstBase也是空,那么就直接把firstPending 这个链表赋给firstBase,也就是
     *
     * 其实有两个链表,一个叫base,一个叫pending,上面这么多操作就是要把pending往base上merge
     *
     *
     */
    // Append pending updates to base queue
    if (lastBaseUpdate === null) {
      firstBaseUpdate = firstPendingUpdate;
    } else {
      lastBaseUpdate.next = firstPendingUpdate;
    }
    lastBaseUpdate = lastPendingUpdate;
    /**
     * 注释翻译:
     * 如果有一个当前队列，并且它与基本队列不同，那么我们也需要将更新转移到该队列。因为基队列是一个没有循环的单链列表，我们可以追加到两个列表上，并利用结构共享的优势。
     * 总之这里听起来就是要把当前的队列和刚才用pending和base拼出来的队列再拼一次.
     *
     * TODO 至于 workInProgress.alternate 这个玩意是什么,在哪里赋值,目前还不清楚,总之定义在了 @type {Fiber}这个类型中.
     * @type {Fiber}
     */
    // If there's a current queue, and it's different from the base queue, then
    // we need to transfer the updates to that queue, too. Because the base
    // queue is a singly-linked list with no cycles, we can append to both
    // lists and take advantage of structural sharing.
    // TODO: Pass `current` as argument
    const current = workInProgress.alternate;
    /**
     * 先判断一下是不是空,空的话就不做任何操作了
     */
    if (current !== null) {
      // This is always non-null on a ClassComponent or HostRoot

      const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
      const currentLastBaseUpdate = currentQueue.lastBaseUpdate;
      /**
       * 判断currentLastBase 和 lastBase是不是一样的,这里有一个细节就是上面拼接pending的时候
       * 已经把 lastBaseUpdate = lastPendingUpdate , 而这个 lastPendingUpdate又是什么呢?
       * lastPendingUpdate 就是最一开始的updateQueue.share.pending.
       *
       * 为啥要判断是不是相等呢? 可以看到只要在不相等的时候才进行下面的操作,意思就是如果相等的话,就没有必要拼接队列了
       * 这里继续留疑问, TODO 啥时候会相等呢?
       *
       *  然后和上面pending一样的拼接逻辑,判断last是不是空,空的话就直接使用pending,不是空的话
       *  就指定last.next = first
       *  再最后再同步一下last的指针.
       *
       */
      if (currentLastBaseUpdate !== lastBaseUpdate) {
        if (currentLastBaseUpdate === null) {
          currentQueue.firstBaseUpdate = firstPendingUpdate;
        } else {
          currentLastBaseUpdate.next = firstPendingUpdate;
        }
        currentQueue.lastBaseUpdate = lastPendingUpdate;
      }
    }
  }
  /**
   *  到这里,都是在拼接对接,但是上面的操作是往两个队列上去拼pending队列, 一个是base,一个current
   *
   *  经过查找 上面对currentQueue更新之后,后面代码中再无涉及currentQueue的逻辑,另外一个疑惑点
   *  我们继续看下面的内容
   */

  /**
   * 后面所有的逻辑都包含在了这个if中
   * 判断firstBase是不是存在,因为在代码运行过程中firstBase会被置为null,但是看了一圈么有发现有置为null的情况
   *
   */
  // These values may change as we process the queue.
  if (firstBaseUpdate !== null) {
    // Iterate through the list of updates to compute the result.
    /**
     * 取出最当前UpdateQueue的baseState
     * @type {*|State}
     */
    let newState = queue.baseState;
    // TODO: Don't need to accumulate this. Instead, we can remove renderLanes
    // from the original lanes.
    let newLanes = NoLanes;

    let newBaseState = null;
    let newFirstBaseUpdate = null;
    let newLastBaseUpdate = null;

    let update = firstBaseUpdate;
    /**
     * 这个do while是一个无限循环,最后直接while true了
     *
     */
    do {
      /**
       * 取firstBase的lane.
       * @type {Lane}
       */
      const updateLane = update.lane;
      /**
       * 取firstBase的eventTime
       * @type {number}
       */
      const updateEventTime = update.eventTime;
      /**
       * renderLanes是这个函数的参数之一, updateLane是当前update的lane
       * 这里是判断当前update的lane是不是lanes的子lane
       */
      if (!isSubsetOfLanes(renderLanes, updateLane)) {
        /**
         * 当前的lane不是参数lanes的子集,不是子集意思就是优先级够不上
         */
        // Priority is insufficient. Skip this update. If this is the first
        // skipped update, the previous update/state is the new base
        // update/state.
        const clone: Update<State> = {
          eventTime: updateEventTime,
          lane: updateLane,

          tag: update.tag,
          payload: update.payload,
          callback: update.callback,

          next: null,
        };
        /**
         * 如果运行的时候发现这newBase是空的,那么就认为是第一次运行
         * 这里逻辑就是,fiber的这次更新队列在被处理的时候,一顿拼装完,开始循环,循环中碰到了一个优先级不高的玩意
         * 就外部的newFirstBase 和 newLastBase直接设置为当前的update,
         * 这里就是base队列的由来了 以及 baseState的由来.
         *
         *
         * 后面循环再碰到优先级不够的,newLastBase他就不会空了,这里开始构造环状结构了,newFirstBase还是指向第一个
         * 优先级不够的update,但是newLastBase就会被更新成新来的优先级不够的update,但是这能构成链表?
         * newFirstBase是第一个低优先级的update,这个update的next被置为了null
         * 后面来再多的低优先级的update 也只会不停的重置newLastBase
         *
         *
         * 我草这里一个新知识点
         *
         * var a = {n: 1};
           var b = a;
           a.x = a = {n: 2};
           alert(a.x); // --> undefined
           alert(b.x); // --> {n: 2}

         * 类比到这段话就是 newLastBaseUpdate = newLastBaseUpdate.next = clone;
         * newLastBaseUpdate = (newLastBaseUpdate.next = clone);
         *
         * let a,b;
           undefined
           a = b = {next:null};
           {next: null}
           b = b.next = {next:null}
           {next: null}
           b
           {next: null}
           a
           {next: {…}}
            这里a是firstBase    b是lastBase
            先一把连续赋值, a = b = {next:null}
         * 这个时候a 和 b都指向了{next:null}所在的地址
         * 再来一个连续赋值   b = b.next = {next:null}
         * 这个看起来是一个自相矛盾的连续赋值, 先 b.next = {next:null} 然后 b = {next:null}
         * 那b肯定是 {next:null} 啊, 这个b.next也肯定是null啊,对这个判断是对的,但是判断的逻辑不对,我以为是b.next值被覆盖了
         * 实际上是b被覆盖了,b.next = {next:null}的结果是  b在上一次连续复制中指向的{next:null}的next值变为了{next:null} 地址指向的空间一致是存在的
         * 只不过b不直接指向它了,但是a是指向它的,所以这个时候 a 就变成了 {next:{next:null}};所以这个链表就构造出来了. 操 过于巧妙让人看不懂
         *
         *
         *
         */
        if (newLastBaseUpdate === null) {
          newFirstBaseUpdate = newLastBaseUpdate = clone;
          newBaseState = newState;
        } else {
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }
        /**
         * 这里有个合并lanes的操作,
         * 0000011
         * 0000100
         * -------
         * 0000111
         * 这低优先级merge低优先级不还是低优先级吗?又不会进位
         * 总之是merge一把之后赋值给newLanes,并且这行以上的分支逻辑中并没有消费newLanes.所以这里就只有去不停的更新这个lanes
         *
         *
         * @type {Lanes}
         */
        // Update the remaining priority in the queue.
        newLanes = mergeLanes(newLanes, updateLane);
      } else {
        // 这个更新确实有足够的优先权。
        // This update does have sufficient priority.
        /**
         * 有了足够的优先权,即是renderLanes的子集,并且newLastBaseUpdate不是空,不是空意思
         * 就是之前已经有低优先级的update进入这个while了,这个逻辑看起来是依然往newBase链表中加节点啊
         * TODO 我草,这是为什么
         *
         * 答案:这里的逻辑是如果在这个update之前有低优先级的update了,那么这个update也要进入base队列中
         * 但是会标记lane为NoLane,这样的话下一次无论如何都会执行
         *
         * 如果 updateQueue是这样 payload|lane
         *
         *  A|2  B|1  C|2  D|1
         *
         */
        if (newLastBaseUpdate !== null) {
          const clone: Update<State> = {
            eventTime: updateEventTime,
            // This update is going to be committed so we never want uncommit
            // it. Using NoLane works because 0 is a subset of all bitmasks, so
            // this will never be skipped by the check above.
            lane: NoLane,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: null,
          };
          newLastBaseUpdate = newLastBaseUpdate.next = clone;
        }
        /**
         * 从队列中的这个update取新的状态出来
         * 跳转到这个函数里面看怎么从update里面取状态的
         *
         * 总之会返回一个状态,是计算之后的状态.
         * @type {*}
         */
        // Process this update.
        newState = getStateFromUpdate(
          /**
           * workInProgress
           * queue
           *
           */
          workInProgress,
          queue,
          update,
          /**
           * 这个state就是初始化的updateQueue中的base,低优先级的分支逻辑中没有对它进行修改
           */
          newState,
          /**
           * 参数中的props,说实话也不知道是啥.. TODO
           */
          props,
          /**
           * 参数中的instance
           */
          instance,
        );

        const callback = update.callback;
        if (
          callback !== null &&
          // If the update was already committed, we should not queue its
          // callback again.
          update.lane !== NoLane
        ) {
          workInProgress.flags |= Callback;
          const effects = queue.effects;
          if (effects === null) {
            queue.effects = [update];
          } else {
            effects.push(update);
          }
        }
      }
      /**
       * 使用update的下一个来更新update
       * @type {Update<State>|Update<A>|*}
       */
      update = update.next;
      /**
       * 判断下一个update是不是null
       */
      if (update === null) {
        /**
         * 之前拼装的base队列走到了尽头
         * 再从pending中取一把,因为前面取 pendingQueue 之后就把 queue.shared.pending置为null
         * 一般情况下 queue.shared.pending 肯定是null,这个时候循环也结束了
         * 但是总有不一般的情况,就是过程中当前的fiber的pending被修改了,pending又有了.
         * @type {Update<State>|*}
         */
        pendingQueue = queue.shared.pending;
        if (pendingQueue === null) {
          break;
        } else {
          // An update was scheduled from inside a reducer. Add the new
          // pending updates to the end of the list and keep processing.
          const lastPendingUpdate = pendingQueue;
          // Intentionally unsound. Pending updates form a circular list, but we
          // unravel them when transferring them to the base queue.
          const firstPendingUpdate = ((lastPendingUpdate.next: any): Update<State>);
          /**
           * 上面继续设置first和 last,下面继续拆环,然后合并到base上去.
           * @type {null}
           */
          lastPendingUpdate.next = null;
          update = firstPendingUpdate;
          queue.lastBaseUpdate = lastPendingUpdate;
          queue.shared.pending = null;
        }
      }
    } while (true);
    /**
     *
     */
    if (newLastBaseUpdate === null) {
      newBaseState = newState;
    }
    /**
     *
     * @type {State}
     */
    queue.baseState = ((newBaseState: any): State);
    queue.firstBaseUpdate = newFirstBaseUpdate;
    queue.lastBaseUpdate = newLastBaseUpdate;

    // Interleaved updates are stored on a separate queue. We aren't going to
    // process them during this render, but we do need to track which lanes
    // are remaining.
    const lastInterleaved = queue.shared.interleaved;
    if (lastInterleaved !== null) {
      let interleaved = lastInterleaved;
      do {
        newLanes = mergeLanes(newLanes, interleaved.lane);
        interleaved = ((interleaved: any).next: Update<State>);
      } while (interleaved !== lastInterleaved);
    } else if (firstBaseUpdate === null) {
      // `queue.lanes` is used for entangling transitions. We can set it back to
      // zero once the queue is empty.
      queue.shared.lanes = NoLanes;
    }

    // Set the remaining expiration time to be whatever is remaining in the queue.
    // This should be fine because the only two other things that contribute to
    // expiration time are props and context. We're already in the middle of the
    // begin phase by the time we start processing the queue, so we've already
    // dealt with the props. Context in components that specify
    // shouldComponentUpdate is tricky; but we'll have to account for
    // that regardless.
    markSkippedUpdateLanes(newLanes);
    workInProgress.lanes = newLanes;
    /**
     * 这里就是setState怎么做的合并,这个函数没有返回值,就是在修改当前的fiber的状态.
     * @type {*|State}
     */
    workInProgress.memoizedState = newState;
  }

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
): void {
  // Commit the effects
  const effects = finishedQueue.effects;
  finishedQueue.effects = null;
  if (effects !== null) {
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      const callback = effect.callback;
      if (callback !== null) {
        effect.callback = null;
        callCallback(callback, instance);
      }
    }
  }
}
