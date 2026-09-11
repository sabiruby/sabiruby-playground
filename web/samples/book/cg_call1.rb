def f(o)
  o.a
  o.b(1)
  o.c(1) { }
  g
  g(1)
  g(1) { }
  self.h
  o.a = 1
  o[1]
  o[0]
  o[1] = 2
  o == 1
  o + 1
  nil
end
