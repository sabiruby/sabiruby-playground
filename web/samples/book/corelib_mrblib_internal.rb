# mrblib の Ruby コードが呼ぶ C の内部メソッドの所在
[[Array, :__svalue], [String, :__sub_replace], [String, :byteindex], [String, :byteslice],
 [Range, :__num_to_a], [Hash, :__delete], [Hash, :__merge], [Integer, :__coerce_step_counter],
 [Kernel, :__method_recursive?], [String, :__upto_endless]].each do |c, m|
  p [c, m, c.instance_methods.include?(m) || c.private_instance_methods.include?(m)]
end
p Enumerable.singleton_methods.include?(:__update_hash), Enumerable.respond_to?(:__update_hash)
p Array.instance_method(:each).owner, [1, 2].respond_to?(:__svalue)
