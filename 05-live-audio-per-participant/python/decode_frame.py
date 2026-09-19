"""
Decoder for MeetStream's binary live-audio frame format.

Every audio frame sent over the WebSocket connection follows this exact
byte layout:

    Byte 0:         msg_type     (1 byte,  uint8)     - always 0x01 for PCM audio
    Bytes 1-2:      sid_length   (2 bytes, uint16 LE) - byte length of speaker_id string
    Bytes 3 to 3+N: speaker_id   (N bytes, UTF-8)      - platform speaker identifier
    Next 2 bytes:   sname_length (2 bytes, uint16 LE) - byte length of speaker_name string
    Next M bytes:   speaker_name (M bytes, UTF-8)      - display name shown in the meeting
    Remaining:      pcm_audio    (rest,    int16 LE)  - raw PCM audio samples

Audio properties:
    Sample rate: 48000 Hz
    Encoding:    signed 16-bit integer PCM
    Byte order:  little-endian
    Channels:    1 (mono)
    Container:   none, raw samples only

Example hex dump for a frame from "Alice" with speaker_id "user_42":

    01  07 00  75 73 65 72 5F 34 32  05 00  41 6C 69 63 65  XX XX XX ...
    |   |      |                     |      |                |
    |   |      |                     |      speaker_name     pcm_audio
    |   |      speaker_id "user_42"  sname_length = 5
    |   sid_length = 7
    msg_type = 0x01
"""

import struct

MSG_TYPE_PCM_AUDIO = 0x01


def decode_audio_frame(data: bytes):
    """
    Decode a single MeetStream binary audio frame.

    Returns (speaker_id, speaker_name, pcm_bytes) on success,
    or None if the frame is malformed at any step.
    """
    # A frame needs at least msg_type (1) + sid_length (2) + sname_length (2)
    if len(data) < 5:
        return None

    # Byte 0: msg_type must be 0x01 for PCM audio
    msg_type = data[0]
    if msg_type != MSG_TYPE_PCM_AUDIO:
        return None

    # Bytes 1-2: sid_length as uint16 little-endian
    sid_length = struct.unpack_from("<H", data, 1)[0]

    # speaker_id starts at byte 3 and runs for sid_length bytes
    sid_start = 3
    sid_end = sid_start + sid_length
    if len(data) < sid_end + 2:
        return None
    try:
        speaker_id = data[sid_start:sid_end].decode("utf-8")
    except UnicodeDecodeError:
        return None

    # The 2 bytes after speaker_id hold sname_length as uint16 little-endian
    sname_length = struct.unpack_from("<H", data, sid_end)[0]

    # speaker_name follows sname_length and runs for sname_length bytes
    sname_start = sid_end + 2
    sname_end = sname_start + sname_length
    if len(data) < sname_end:
        return None
    try:
        speaker_name = data[sname_start:sname_end].decode("utf-8")
    except UnicodeDecodeError:
        return None

    # Everything left over is the raw PCM16 audio payload
    pcm_bytes = data[sname_end:]

    return (speaker_id, speaker_name, pcm_bytes)


def duration_ms(pcm_bytes: bytes, sample_rate: int = 48000) -> float:
    """
    Calculate the duration in milliseconds of a raw PCM16 audio buffer.
    """
    # Each sample is 2 bytes (int16)
    num_samples = len(pcm_bytes) // 2
    return (num_samples / sample_rate) * 1000
