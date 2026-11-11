#!/usr/bin/env python3
"""rtsp-pull.py: read a Ring live stream (RTSPS) and write its video as MPEG-TS to stdout.

Usage: python3 -I rtsp-pull.py <rtsps-url-without-token> <max-seconds>
The Ring access token is read from the first line of stdin, so it never appears in a command line or a log.
GStreamer's rtspsrc carries it as the RTSP password (Basic auth), the way Ring documents for GStreamer.
Exit codes: 0 stream ended or reached max-seconds, 2 bad arguments, 3 could not connect or authenticate,
4 no video in the stream, 5 stopped by the reader closing the pipe (normal when ffmpeg has what it needs).
"""
import sys

import gi

gi.require_version('Gst', '1.0')
from gi.repository import GLib, Gst  # noqa: E402

DEPAY = {'H264': ('rtph264depay', 'h264parse', 'video/x-h264'), 'H265': ('rtph265depay', 'h265parse', 'video/x-h265')}
# Ring sends a key picture as four slices, each in its own RTP frame (own timestamp, marker bit set). Taken as
# they come, each slice became a picture of its own: ffmpeg decoded a quarter of the image and smeared the rest,
# and every frame after it built on that. So the depayloader hands over single NAL units with the marker flag
# cleared, and the parser joins the slices of each picture into one access unit by the bitstream alone (a new
# picture starts at an AUD/SPS/PPS/SEI or a slice at macroblock 0), before the codec headers are repeated.
# H.265 gets the same treatment but is untested: Ring sends H.264.


def clear_marker(_pad, info):
    buf = info.get_buffer()
    if buf is not None and buf.has_flags(Gst.BufferFlags.MARKER):
        buf.unset_flags(Gst.BufferFlags.MARKER)
    return Gst.PadProbeReturn.OK


def main():
    if len(sys.argv) != 3 or not sys.argv[1].startswith('rtsps://') or '?' in sys.argv[1] or '@' in sys.argv[1]:
        return 2
    try:
        max_s = max(1, min(int(sys.argv[2]), 75))
    except ValueError:
        return 2
    token = sys.stdin.readline().strip()
    sys.stdin.close()
    if not token or len(token) > 8192:
        return 2

    Gst.init(None)
    pipe = Gst.Pipeline.new('pull')
    src = Gst.ElementFactory.make('rtspsrc', 'src')
    mux = Gst.ElementFactory.make('mpegtsmux', 'mux')
    sink = Gst.ElementFactory.make('fdsink', 'sink')
    if not (src and mux and sink):
        return 3
    src.set_property('location', sys.argv[1])
    src.set_property('user-id', 'x')
    src.set_property('user-pw', token)
    src.set_property('protocols', 4)            # GST_RTSP_LOWER_TRANS_TCP: Ring only offers interleaved TCP
    src.set_property('latency', 0)
    src.set_property('tcp-timeout', 20 * 1000000)
    sink.set_property('fd', 1)
    sink.set_property('sync', False)
    for e in (src, mux, sink):
        pipe.add(e)
    mux.link(sink)
    state = {'code': 0, 'video': False}
    loop = GLib.MainLoop()

    def on_pad(_src, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        st = caps.get_structure(0) if caps and caps.get_size() else None
        if not st or st.get_string('media') != 'video':
            fake = Gst.ElementFactory.make('fakesink', None)
            pipe.add(fake)
            fake.sync_state_with_parent()
            pad.link(fake.get_static_pad('sink'))
            return
        names = DEPAY.get((st.get_string('encoding-name') or '').upper())
        if not names or state['video']:
            return
        depay = Gst.ElementFactory.make(names[0], None)
        parse = Gst.ElementFactory.make(names[1], None)
        parse.set_property('config-interval', -1)  # repeat the codec headers so a frame can be decoded at once
        nal = Gst.ElementFactory.make('capsfilter', None)
        nal.set_property('caps', Gst.Caps.from_string(names[2] + ',stream-format=byte-stream,alignment=nal'))
        au = Gst.ElementFactory.make('capsfilter', None)
        au.set_property('caps', Gst.Caps.from_string(names[2] + ',stream-format=byte-stream,alignment=au'))
        for e in (depay, nal, parse, au):
            pipe.add(e)
            e.sync_state_with_parent()
        depay.get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, clear_marker)
        depay.link(nal)
        nal.link(parse)
        parse.link(au)
        au.link(mux)
        pad.link(depay.get_static_pad('sink'))
        state['video'] = True

    src.connect('pad-added', on_pad)

    def on_msg(_bus, msg):
        if msg.type == Gst.MessageType.EOS:
            loop.quit()
        elif msg.type == Gst.MessageType.ERROR:
            err, _dbg = msg.parse_error()
            text = (err.message or '').lower()
            if msg.src is sink or 'broken pipe' in text or 'write' in text:
                state['code'] = 5
            else:
                state['code'] = 3
                sys.stderr.write('rtsp-pull: ' + (err.message or 'error')[:200] + '\n')
            loop.quit()

    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect('message', on_msg)

    def stop():
        loop.quit()
        return False

    GLib.timeout_add_seconds(max_s, stop)
    GLib.timeout_add_seconds(25, lambda: (state['video'] or (state.__setitem__('code', 4) or loop.quit())) and False)
    if pipe.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        return 3
    try:
        loop.run()
    finally:
        pipe.set_state(Gst.State.NULL)          # sends TEARDOWN so the session closes at once
    if not state['video'] and state['code'] == 0:
        return 4
    return state['code']


if __name__ == '__main__':
    sys.exit(main())
