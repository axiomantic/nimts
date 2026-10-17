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

    var outPtr: pointer = nil
    var outLen: int32 = 0
    let recvRes = nimts_chan_try_recv(chanId, addr outPtr, addr outLen)
    check recvRes == 1
    check outPtr != nil
    check outLen == msg.len.int32

    let receivedStr = readString(cast[ptr char](outPtr), outLen)
    check receivedStr == msg
    nimts_free(outPtr)

    # Empty queue returns 0
    check nimts_chan_try_recv(chanId, addr outPtr, addr outLen) == 0

    # Core namespaced C-ABI aliases
    let coreSendRes = nimts_core_chan_send(chanId, cast[pointer](msg.cstring), msg.len.int32)
    check coreSendRes == 1
    check nimts_core_chan_is_closed(chanId) == 0

    nimts_core_chan_close(chanId)
    check nimts_core_chan_is_closed(chanId) == 1

    # Cannot send to closed channel returns -1
    check nimts_core_chan_send(chanId, cast[pointer](msg.cstring), msg.len.int32) == -1

    nimts_chan_destroy(chanId)
