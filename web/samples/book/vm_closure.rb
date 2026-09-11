def mk
  x = 1
  -> { x += 1 }
end
l = mk
p l.call, l.call
