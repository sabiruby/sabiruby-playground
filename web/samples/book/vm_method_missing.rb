class B
  def method_missing(n, *a); [n, a]; end
end
p B.new.foo(1, 2)
