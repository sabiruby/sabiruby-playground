# Object と Kernel（組込みクラスの章）: Object 自身にはメソッドが無い
p Object.instance_methods(false)
p Kernel.instance_methods(false).size
p [method(:puts).owner, method(:lambda).owner, [].method(:map).owner,
   (1..2).method(:each).owner, 1.method(:between?).owner]
p [Array.instance_method(:each).source_location, defined?(@x), defined?(foo)]
p [nil & true, nil | 1, true ^ true, nil.to_s, nil.inspect]
p [RUBY_VERSION, MRUBY_VERSION, MRUBY_RELEASE_NO, MRUBY_PLATFORM]
p [GC.interval_ratio, GC.step_ratio, GC.generational_mode, GC.malloc_threshold]
p GC.stat.keys
