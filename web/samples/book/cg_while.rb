def f(a)
  while a
    a = g
  end
  x = while a
    break 1 if h
  end
  until a
    a = g
  end
  begin
    a = g
  end while a
  nil
end
