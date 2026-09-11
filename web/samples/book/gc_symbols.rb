syms_before = GC.stat[:dynamic_symbol_count]
100.times { |i| "dyn_#{i}".to_sym }
p GC.stat[:dynamic_symbol_count] - syms_before
GC.start
p GC.stat[:dynamic_symbol_count] - syms_before
p :abc.to_s, "abcde".to_sym
p ObjectSpace.respond_to?(:count_objects)
