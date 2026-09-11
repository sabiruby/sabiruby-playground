def f(x, o)
  a, b = 1, 2
  a, *c, d = x
  o.m, o[0] = 3, 4
  [a, b, c, d]
end
