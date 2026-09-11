def f(a, b)
  if a
    1
  else
    2
  end
  x = if a then 3 end
  y = a.nil? ? 4 : 5
  z = a && b
  w = a || b
  if true
    6
  end
  unless a
    7
  end
  nil
end
