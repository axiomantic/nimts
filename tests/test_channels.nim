# tests/test_channels.nim - Unit tests for NimTsChannel SPSC topology and C-ABI
# Licensed under MIT License.

import std/unittest
import std/options
import nimts/channels
import nimts/memory

suite "NimTsChannel SPSC Ring Buffer Verification":

  test "Basic channel send and recv":
    let chan = newNimTsChannel[int](16)
    check chan.capacity == 16
    check chan.len == 0
    check chan.isEmpty
    check not chan.isFull
    check not chan.isClosed()

    check chan.send(100)
    check chan.send(200)
    check chan.len == 2
    check not chan.isEmpty

    var val: int
    check chan.tryRecv(val)
    check val == 100
    check chan.len == 1

    let opt = chan.recv()
    check opt.isSome
    check opt.get() == 200
    check chan.len == 0
    check chan.isEmpty

  test "Channel full capacity rejection":
    let chan = newNimTsChannel[string](4)
    check chan.capacity == 4
    check chan.send("A")
    check chan.send("B")
    check chan.send("C")
    check chan.send("D")
    check chan.isFull
    check chan.len == 4

    # 5th item rejected
    check not chan.send("E")
    check chan.len == 4

    # Drain one
    var item: string
    check chan.tryRecv(item)
    check item == "A"
    check not chan.isFull

    # Now send succeeds
    check chan.send("E")
    check chan.isFull

  test "Channel modular index wrap-around":
    let chan = newNimTsChannel[int](4)
    for cycle in 0 ..< 20:
      check chan.send(cycle)
      var val: int
      check chan.tryRecv(val)
      check val == cycle
    check chan.len == 0

  test "Channel close lifecycle":
    let chan = newNimTsChannel[int](8)
    check chan.send(1)
    check chan.send(2)
    check not chan.isClosed()

    chan.close()
    check chan.isClosed()
    # Cannot send to closed channel
    check not chan.send(3)

    # Can drain remaining buffered items
    var val: int
    check chan.tryRecv(val)
    check val == 1
    check chan.tryRecv(val)
    check val == 2

    # Now empty and closed
    check not chan.tryRecv(val)
    check chan.recv().isNone

  test "Channel C-ABI exports":
    let chanId = nimts_chan_create(16)
    check chanId > 0
    check nimts_chan_is_closed(chanId) == 0

    let msg = "Hello from Host"
    let sendRes = nimts_chan_send(chanId, cast[pointer](msg.cstring), msg.len.int32)
    check sendRes == 1

    let packed = nimts_chan_try_recv(chanId)
    check packed != 0'u64
    let ptrVal = gLastResultPtr
    let lenVal = gLastResultLen
    check ptrVal != nil
    check lenVal == msg.len.int32

    let receivedStr = readString(cast[ptr char](ptrVal), lenVal)
    check receivedStr == msg
    nimts_free(ptrVal)

    # Empty queue returns 0
    check nimts_chan_try_recv(chanId) == 0'u64

    # Core namespaced C-ABI aliases
    let coreSendRes = nimts_core_chan_send(chanId, cast[pointer](msg.cstring), msg.len.int32)
    check coreSendRes == 1
    check nimts_core_chan_is_closed(chanId) == 0

    nimts_core_chan_close(chanId)
    check nimts_core_chan_is_closed(chanId) == 1

    # Cannot send to closed channel returns -1
    check nimts_core_chan_send(chanId, cast[pointer](msg.cstring), msg.len.int32) == -1

    nimts_chan_destroy(chanId)

  test "Channel[T] alias and newChannel[T]":
    let ch = newChannel[int32](8)
    check ch.capacity == 8
    check ch.send(42'i32)
    var val: int32
    check ch.tryRecv(val)
    check val == 42'i32

  test "nimts_chan_get_raw_ptrs raw memory pointer extraction":
    let chan = newChannel[int32](16)
    check chan.send(100'i32)
    check chan.send(200'i32)
    let chanId = registerChannel(chan)
    check chanId > 0

    var headPtr: pointer = nil
    var tailPtr: pointer = nil
    var bufPtr: pointer = nil
    var capVal: int32 = 0

    let res = nimts_chan_get_raw_ptrs(chanId, addr headPtr, addr tailPtr, addr bufPtr, addr capVal)
    check res == 0
    check headPtr != nil
    check tailPtr != nil
    check bufPtr != nil
    check capVal == 16

    when not defined(js):
      let headVal = cast[ptr uint32](headPtr)[]
      let tailVal = cast[ptr uint32](tailPtr)[]
      check headVal == 2'u32
      check tailVal == 0'u32

      let firstItem = cast[ptr int32](bufPtr)[]
      check firstItem == 100'i32

    # Core namespaced C-ABI alias
    var headPtrCore: pointer = nil
    var tailPtrCore: pointer = nil
    var bufPtrCore: pointer = nil
    var capValCore: int32 = 0
    let resCore = nimts_core_chan_get_raw_ptrs(chanId, addr headPtrCore, addr tailPtrCore, addr bufPtrCore, addr capValCore)
    check resCore == 0
    check headPtrCore == headPtr
    check tailPtrCore == tailPtr
    check bufPtrCore == bufPtr
    check capValCore == 16

    nimts_chan_destroy(chanId)
