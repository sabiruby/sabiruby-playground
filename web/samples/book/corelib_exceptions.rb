# 例外の階層とバックトレース（組込みクラスの章）
def bt_a; bt_b; end
def bt_b; raise "x"; end
begin
  bt_a
rescue => e
  p [e.class, e.message, e.backtrace]
end
begin; raise ArgumentError; rescue => e; p [e.message, e.inspect]; end
p [KeyError.superclass, FloatDomainError.superclass, FrozenError.superclass,
   StopIteration.superclass, NoMatchingPatternError.superclass]
p e.respond_to?(:full_message)
cs = []
ObjectSpace.each_object(Class) do |c|
  cs << c if c.is_a?(Class) && c.ancestors.include?(Exception)
end
p cs.size
