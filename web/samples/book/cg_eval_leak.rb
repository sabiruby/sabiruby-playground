class K; end
def f
  K.class_eval "def hi; :hi; end"
  def g; 2; end                  # 期待はObject、実際はK
end
f
p K.new.respond_to?(:g, true), Object.new.respond_to?(:g, true)
