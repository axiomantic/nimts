import unittest
import nimts

suite "nimts":
  test "hello returns expected greeting":
    check hello() == "hello from nimts"

  test "version present":
    check projectVersion == "0.0.1"
