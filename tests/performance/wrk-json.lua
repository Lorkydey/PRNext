-- wrk's own latency histogram supplies p95, which its default text omits.
done = function(summary, latency, requests)
  local errors = summary.errors
  io.write(string.format('PRNEXT_RESULT {"count":%d,"rps":%.6f,"elapsedSeconds":%.6f,"p50":%.6f,"p95":%.6f,"p99":%.6f,"errors":%d,"connectErrors":%d,"readErrors":%d,"writeErrors":%d,"timeouts":%d,"statusErrors":%d,"bytes":%d}\n',
    summary.requests,summary.requests/(summary.duration/1000000),summary.duration/1000000,
    latency:percentile(50)/1000,latency:percentile(95)/1000,latency:percentile(99)/1000,
    errors.connect+errors.read+errors.write+errors.timeout+errors.status,
    errors.connect,errors.read,errors.write,errors.timeout,errors.status,summary.bytes))
end
