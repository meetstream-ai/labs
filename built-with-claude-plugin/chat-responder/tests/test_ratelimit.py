from chat_responder.ratelimit import RateLimiter


def test_sender_cooldown_blocks_repeats():
    limiter = RateLimiter(sender_cooldown_seconds=5.0, max_per_minute=100)
    assert limiter.allow("alice", 0.0)
    assert not limiter.allow("alice", 4.9)
    assert limiter.allow("alice", 5.1)


def test_cooldown_is_per_sender():
    limiter = RateLimiter(sender_cooldown_seconds=5.0, max_per_minute=100)
    assert limiter.allow("alice", 0.0)
    assert limiter.allow("bob", 0.1)


def test_global_cap_stops_a_crowd():
    limiter = RateLimiter(sender_cooldown_seconds=0.0, max_per_minute=3)
    for index in range(3):
        assert limiter.allow("person{}".format(index), float(index))
    assert not limiter.allow("person4", 3.0)


def test_global_cap_resets_after_the_window():
    limiter = RateLimiter(sender_cooldown_seconds=0.0, max_per_minute=2)
    assert limiter.allow("alice", 0.0)
    assert limiter.allow("bob", 1.0)
    assert not limiter.allow("carol", 2.0)
    assert limiter.allow("carol", 61.0)


def test_sender_table_stays_bounded():
    limiter = RateLimiter(sender_cooldown_seconds=1.0, max_per_minute=100000)
    for index in range(2000):
        limiter.allow("person{}".format(index), float(index))
    assert len(limiter._last_by_sender) < 600
