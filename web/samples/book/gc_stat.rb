p GC.stat
p GC.generational_mode, GC.interval_ratio, GC.step_ratio,
  GC.step_limit, GC.malloc_threshold
before = GC.stat[:live]
a = Array.new(5000) { |i| "s#{i}" }
p GC.stat[:live] - before
a = nil
GC.start
p GC.stat[:live] - before
p GC.stat[:state], GC.stat[:debt]
GC.generational_mode = false
p GC.generational_mode
10.times { Array.new(1000) { Object.new } }
p GC.stat[:state]
