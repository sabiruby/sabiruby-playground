# GC の負債と生存数を観察する（GC の章）。数値は環境で変わる
def st; s = GC.stat; [s[:live], s[:debt]]; end
GC.start
p [:start, st]
a = Array.new(1000) { |i| "s#{i}" }
p [:alloc_1000, st]
GC.disable
b = Array.new(5000) { |i| [i] }
p [:disabled_5000, st]
GC.enable
a = b = nil
GC.start
p [:enable_start, st]
p [:malloc, GC.stat[:malloc_increase], GC.stat[:malloc_threshold]]
big = "x" * (20 * 1024 * 1024)
p [:string_20MB, GC.stat[:malloc_increase], st]
