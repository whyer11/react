/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AnyNativeEvent} from '../events/PluginModuleType';
import type {FiberRoot} from 'react-reconciler/src/ReactInternalTypes';
import type {Container, SuspenseInstance} from '../client/ReactDOMHostConfig';
import type {DOMEventName} from '../events/DOMEventNames';

import {
  isReplayableDiscreteEvent,
  queueDiscreteEvent,
  hasQueuedDiscreteEvents,
  clearIfContinuousEvent,
  queueIfContinuousEvent,
} from './ReactDOMEventReplaying';
import {
  getNearestMountedFiber,
  getContainerFromFiber,
  getSuspenseInstanceFromFiber,
} from 'react-reconciler/src/ReactFiberTreeReflection';
import {HostRoot, SuspenseComponent} from 'react-reconciler/src/ReactWorkTags';
import {type EventSystemFlags, IS_CAPTURE_PHASE} from './EventSystemFlags';

import getEventTarget from './getEventTarget';
import {getClosestInstanceFromNode} from '../client/ReactDOMComponentTree';

import {dispatchEventForPluginEventSystem} from './DOMPluginEventSystem';

import {
  getCurrentPriorityLevel as getCurrentSchedulerPriorityLevel,
  IdlePriority as IdleSchedulerPriority,
  ImmediatePriority as ImmediateSchedulerPriority,
  LowPriority as LowSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  UserBlockingPriority as UserBlockingSchedulerPriority,
} from 'react-reconciler/src/Scheduler';
import {
  DiscreteEventPriority,
  ContinuousEventPriority,
  DefaultEventPriority,
  IdleEventPriority,
  getCurrentUpdatePriority,
  setCurrentUpdatePriority,
} from 'react-reconciler/src/ReactEventPriorities';
import ReactSharedInternals from 'shared/ReactSharedInternals';

const {ReactCurrentBatchConfig} = ReactSharedInternals;

// TODO: can we stop exporting these?
export let _enabled = true;

// This is exported in FB builds for use by legacy FB layer infra.
// We'd like to remove this but it's not clear if this is safe.
export function setEnabled(enabled: ?boolean) {
  _enabled = !!enabled;
}

export function isEnabled() {
  return _enabled;
}

export function createEventListenerWrapper(
  targetContainer: EventTarget,
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
): Function {
  return dispatchEvent.bind(
    null,
    domEventName,
    eventSystemFlags,
    targetContainer,
  );
}

export function createEventListenerWrapperWithPriority(
  targetContainer: EventTarget,
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
): Function {
  /**
   * 这里对事件进行了优先级划分,所谓划分就是把所有具有优先级的事件标记上优先级,
   * 然后再对事件优先级和fiber的lane进行映射
   * 比如说click 就是syncLane
   * @type {*}
   */
  const eventPriority = getEventPriority(domEventName);
  /**
   * 这个listenerWrapper其实就是最后的listener了只不过还需要根据不一样优先级
   * 使用不同的函数
   */
  let listenerWrapper;
  switch (eventPriority) {
    case DiscreteEventPriority:
      /**
       * 使用离散事件的dispatch
       * 这里的离散事件 和 连续事件定义也很迷
       * click 这种是离散, 给了最高优先级
       * scroll 认为是连续, 给了第三优先级
       * @type {dispatchDiscreteEvent}
       */
      listenerWrapper = dispatchDiscreteEvent;
      break;
    case ContinuousEventPriority:
      // 连续事件
      listenerWrapper = dispatchContinuousEvent;
      break;
      // message 和 其他方法的时候就会使用这个优先级
    case DefaultEventPriority:
    default:
      listenerWrapper = dispatchEvent;
      break;
  }
  /**
   * 这个所谓的wrapper 其实就是一个转发器,把不同事件转发到不同的dispatch上,并且事件出发的时候修改其入参
   * 生成的函数的this是null ??? 这玩意不是要给后面的addEventListener用吗?
   */
  return listenerWrapper.bind(
    null,
    domEventName,
    eventSystemFlags,
    targetContainer,
  );
}

/**
 * 分派离散事件
 *
 * @param domEventName
 * @param eventSystemFlags
 * @param container
 * @param nativeEvent
 */
function dispatchDiscreteEvent(
  domEventName,
  eventSystemFlags,
  container,
  nativeEvent,
) {
  /**
   * 这个fiber的优先级我们不多废话,反正就是拿到了一个优先级
   * @type {EventPriority}
   */
  const previousPriority = getCurrentUpdatePriority();
  /**
   * transition 不知道是啥 TODO
   * 反正记为了0
   * @type {number|*}
   */
  const prevTransition = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = 0;
  try {
    /**
     * 这里比较精彩,这是一个listener,然后他在执行的时候会变更当前正在更新的Fiber的优先级,
     * 上面取当前更新的Fiber优先级的时候定义为上一个优先级.众所周知 Fiber tree 其实就是vdom tree的链表版
     * 一个listener被触发的时候,当前必然有fiber的update在被process,所以这个dispatchEvent,盲猜应该就是往updateQueue中塞update了
     * 好的我盲猜错误了,这里是运行dispatchEvent的时候,就直接同步运行了,这个改优先级的操作应该是让fiber里面的其他update不要抢资源了
     * 顺着这个看看下去就是在同步执行一个函数 还是 用fn.apply的方式然后把合成事件传递进去
     *
     * 这个只是离散事件,其他事件的逻辑都是一样的.
     *
     * 不过到这里呢,还没有获取到真正绑定的那个函数,我们继续往下看
     */
    setCurrentUpdatePriority(DiscreteEventPriority);
    dispatchEvent(domEventName, eventSystemFlags, container, nativeEvent);
  } finally {
    setCurrentUpdatePriority(previousPriority);
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}

function dispatchContinuousEvent(
  domEventName,
  eventSystemFlags,
  container,
  nativeEvent,
) {
  const previousPriority = getCurrentUpdatePriority();
  const prevTransition = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = 0;
  try {
    setCurrentUpdatePriority(ContinuousEventPriority);
    dispatchEvent(domEventName, eventSystemFlags, container, nativeEvent);
  } finally {
    setCurrentUpdatePriority(previousPriority);
    ReactCurrentBatchConfig.transition = prevTransition;
  }
}

/**
 * 不管是什么dispatch 最终都是到这里来
 * @param domEventName
 * @param eventSystemFlags
 * @param targetContainer
 * @param nativeEvent
 */
export function dispatchEvent(
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): void {
  if (!_enabled) {
    return;
  }
  /**
   * 什么玩意跟 100 与一下变成0呢
      妈的 这个意思就是 只要 eventSystemFlags !== IS_CAPTURE_PHASE 草为什么要这么写啊 只有 IS_CAPTURE_PHASE&IS_CAPTURE_PHASE !== 0
   其他flag 与出来都是0啊
   * @type {boolean}
   */
  // TODO: replaying capture phase events is currently broken
  // because we used to do it during top-level native bubble handlers
  // but now we use different bubble and capture handlers.
  // In eager mode, we attach capture listeners early, so we need
  // to filter them out until we fix the logic to handle them correctly.
  const allowReplay = (eventSystemFlags & IS_CAPTURE_PHASE) === 0;
  /**
   * 1. 不在捕获阶段
   * 2. 有其他的离散事件在排队
   * 3. 是可重放的离散事件
   * 都是true的时候
   * 我们就排队,然后这个方法就return了
   * 意思就是当一个事件符合上面条件,就只是放进来排队,我们看看队怎么排的
   */
  if (
    allowReplay &&
    hasQueuedDiscreteEvents() &&
    isReplayableDiscreteEvent(domEventName)
  ) {
    /**
     *
     */
    // If we already have a queue of discrete events, and this is another discrete
    // event, then we can't dispatch it regardless of its target, since they
    // need to dispatch in order.
    queueDiscreteEvent(
      null, // Flags that we're not actually blocked on anything as far as we know.
      domEventName,
      eventSystemFlags,
      targetContainer,
      nativeEvent,
    );
    return;
  }

  const blockedOn = attemptToDispatchEvent(
    domEventName,
    eventSystemFlags,
    targetContainer,
    nativeEvent,
  );

  if (blockedOn === null) {
    // We successfully dispatched this event.
    if (allowReplay) {
      clearIfContinuousEvent(domEventName, nativeEvent);
    }
    return;
  }

  if (allowReplay) {
    if (isReplayableDiscreteEvent(domEventName)) {
      // This this to be replayed later once the target is available.
      queueDiscreteEvent(
        blockedOn,
        domEventName,
        eventSystemFlags,
        targetContainer,
        nativeEvent,
      );
      return;
    }
    if (
      queueIfContinuousEvent(
        blockedOn,
        domEventName,
        eventSystemFlags,
        targetContainer,
        nativeEvent,
      )
    ) {
      return;
    }
    // We need to clear only if we didn't queue because
    // queueing is accumulative.
    clearIfContinuousEvent(domEventName, nativeEvent);
  }
  /**
   * 先不管上面哪些if ,总之都会到这里来.
   *
   * 这个函数第四个参数是null,下面的注释也解释了,说是不可重播所以就不需要target
   */
  // This is not replayable so we'll invoke it but without a target,
  // in case the event system needs to trace it.
  dispatchEventForPluginEventSystem(
    domEventName,
    eventSystemFlags,
    nativeEvent,
    null,
    targetContainer,
  );
}

// Attempt dispatching an event. Returns a SuspenseInstance or Container if it's blocked.
export function attemptToDispatchEvent(
  domEventName: DOMEventName,
  eventSystemFlags: EventSystemFlags,
  targetContainer: EventTarget,
  nativeEvent: AnyNativeEvent,
): null | Container | SuspenseInstance {
  // TODO: Warn if _enabled is false.

  const nativeEventTarget = getEventTarget(nativeEvent);
  let targetInst = getClosestInstanceFromNode(nativeEventTarget);

  if (targetInst !== null) {
    const nearestMounted = getNearestMountedFiber(targetInst);
    if (nearestMounted === null) {
      // This tree has been unmounted already. Dispatch without a target.
      targetInst = null;
    } else {
      const tag = nearestMounted.tag;
      if (tag === SuspenseComponent) {
        const instance = getSuspenseInstanceFromFiber(nearestMounted);
        if (instance !== null) {
          // Queue the event to be replayed later. Abort dispatching since we
          // don't want this event dispatched twice through the event system.
          // TODO: If this is the first discrete event in the queue. Schedule an increased
          // priority for this boundary.
          return instance;
        }
        // This shouldn't happen, something went wrong but to avoid blocking
        // the whole system, dispatch the event without a target.
        // TODO: Warn.
        targetInst = null;
      } else if (tag === HostRoot) {
        const root: FiberRoot = nearestMounted.stateNode;
        if (root.hydrate) {
          // If this happens during a replay something went wrong and it might block
          // the whole system.
          return getContainerFromFiber(nearestMounted);
        }
        targetInst = null;
      } else if (nearestMounted !== targetInst) {
        // If we get an event (ex: img onload) before committing that
        // component's mount, ignore it for now (that is, treat it as if it was an
        // event on a non-React tree). We might also consider queueing events and
        // dispatching them after the mount.
        targetInst = null;
      }
    }
  }
  dispatchEventForPluginEventSystem(
    domEventName,
    eventSystemFlags,
    nativeEvent,
    targetInst,
    targetContainer,
  );
  // We're not blocked on anything.
  return null;
}

export function getEventPriority(domEventName: DOMEventName): * {
  switch (domEventName) {
    // Used by SimpleEventPlugin:
    case 'cancel':
    case 'click':
    case 'close':
    case 'contextmenu':
    case 'copy':
    case 'cut':
    case 'auxclick':
    case 'dblclick':
    case 'dragend':
    case 'dragstart':
    case 'drop':
    case 'focusin':
    case 'focusout':
    case 'input':
    case 'invalid':
    case 'keydown':
    case 'keypress':
    case 'keyup':
    case 'mousedown':
    case 'mouseup':
    case 'paste':
    case 'pause':
    case 'play':
    case 'pointercancel':
    case 'pointerdown':
    case 'pointerup':
    case 'ratechange':
    case 'reset':
    case 'seeked':
    case 'submit':
    case 'touchcancel':
    case 'touchend':
    case 'touchstart':
    case 'volumechange':
    // Used by polyfills:
    // eslint-disable-next-line no-fallthrough
    case 'change':
    case 'selectionchange':
    case 'textInput':
    case 'compositionstart':
    case 'compositionend':
    case 'compositionupdate':
    // Only enableCreateEventHandleAPI:
    // eslint-disable-next-line no-fallthrough
    case 'beforeblur':
    case 'afterblur':
    // Not used by React but could be by user code:
    // eslint-disable-next-line no-fallthrough
    case 'beforeinput':
    case 'blur':
    case 'fullscreenchange':
    case 'focus':
    case 'hashchange':
    case 'popstate':
    case 'select':
    case 'selectstart':
      return DiscreteEventPriority;
    case 'drag':
    case 'dragenter':
    case 'dragexit':
    case 'dragleave':
    case 'dragover':
    case 'mousemove':
    case 'mouseout':
    case 'mouseover':
    case 'pointermove':
    case 'pointerout':
    case 'pointerover':
    case 'scroll':
    case 'toggle':
    case 'touchmove':
    case 'wheel':
    // Not used by React but could be by user code:
    // eslint-disable-next-line no-fallthrough
    case 'mouseenter':
    case 'mouseleave':
    case 'pointerenter':
    case 'pointerleave':
      return ContinuousEventPriority;
    case 'message': {
      // We might be in the Scheduler callback.
      // Eventually this mechanism will be replaced by a check
      // of the current priority on the native scheduler.
      const schedulerPriority = getCurrentSchedulerPriorityLevel();
      switch (schedulerPriority) {
        case ImmediateSchedulerPriority:
          return DiscreteEventPriority;
        case UserBlockingSchedulerPriority:
          return ContinuousEventPriority;
        case NormalSchedulerPriority:
        case LowSchedulerPriority:
          // TODO: Handle LowSchedulerPriority, somehow. Maybe the same lane as hydration.
          return DefaultEventPriority;
        case IdleSchedulerPriority:
          return IdleEventPriority;
        default:
          return DefaultEventPriority;
      }
    }
    default:
      return DefaultEventPriority;
  }
}
