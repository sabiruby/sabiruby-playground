def f(b, h)
  s = "a#{b}c"
  y = :"a#{b}"
  t = "#{b}"
  hh = {a: 1, **h, b: 2}
  r = (1..b)
  s
end
