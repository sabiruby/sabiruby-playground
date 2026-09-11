def f(o, h)
  @a += 1
  $g ||= 1
  @b &&= 2
  h[:k] += 1
  o.x += 1
  nil
end
def g
  A ||= 1
end
